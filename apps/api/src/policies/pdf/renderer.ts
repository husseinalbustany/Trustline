import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The browser that prints, installed with the deployment. */
export const BROWSER_VARIABLE = 'PDF_BROWSER';
/** Where the embedded faces are read from. */
export const FONT_DIR_VARIABLE = 'PDF_FONT_DIR';

const BROWSERS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
const FONTS = { regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf' };
/** Seconds one PDF may take before its browser is killed. */
export const PDF_TIMEOUT_MS = 30_000;
/** PDFs made at once in one API process; the rest wait their turn. */
const AT_ONCE = 2;
const QUEUE = 20;

/**
 * The shared renderer (docs/specs/document-pdf.md, "The renderer"): a page
 * of HTML printed to PDF by a headless browser, in a process of its own for
 * each PDF, with an empty profile in a private directory, no network (a
 * proxy that is not there, names that resolve to nothing, background
 * networking off), no session, a time limit, and at most two at once. The
 * page itself must load nothing: its content security policy allows only
 * its own style, and fonts and images as `data:`. The faces it embeds are
 * read once, from the deployment's files, never fetched.
 */
@Injectable()
export class PdfRenderer {
  private readonly logger = new Logger(PdfRenderer.name);
  readonly browser: string | null;
  /** The faces as `@font-face` rules with `data:` sources, or none. */
  readonly fontFaces: string;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor() {
    const named = process.env[BROWSER_VARIABLE]?.trim();
    this.browser = named ? (existsSync(named) ? named : null) : (BROWSERS.find((b) => existsSync(b)) ?? null);
    const dir = process.env[FONT_DIR_VARIABLE]?.trim() || '/usr/share/fonts/truetype/dejavu';
    const face = (file: string, weight: number) => {
      const path = join(dir, file);
      if (!existsSync(path)) return '';
      return `@font-face { font-family: "Trustline Document"; font-weight: ${weight}; src: url(data:font/ttf;base64,${readFileSync(path).toString('base64')}) format("truetype"); }`;
    };
    this.fontFaces = [face(FONTS.regular, 400), face(FONTS.bold, 700)].join('\n');
  }

  /** Said once at start: what the PDFs lack here. */
  warn() {
    if (!this.browser) this.logger.warn(`No browser for PDFs (${BROWSER_VARIABLE}): the PDF routes answer 503`);
    if (!this.fontFaces.trim()) this.logger.warn(`No faces to embed in PDFs (${FONT_DIR_VARIABLE}): the system's are used`);
  }

  private async turn() {
    if (this.running < AT_ONCE) {
      this.running++;
      return;
    }
    if (this.waiting.length >= QUEUE) throw new ServiceUnavailableException({ code: 'pdf_busy' });
    await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
  }

  private done() {
    this.running--;
    this.waiting.shift()?.();
  }

  /** The page printed to PDF. 503 `pdf_unavailable` without a browser. */
  async render(html: string): Promise<Buffer> {
    if (!this.browser) throw new ServiceUnavailableException({ code: 'pdf_unavailable' });
    await this.turn();
    const dir = await mkdtemp(join(tmpdir(), 'trustline-pdf-'));
    try {
      const page = join(dir, 'page.html');
      const out = join(dir, 'page.pdf');
      await writeFile(page, html, { mode: 0o600 });
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(dir, 'profile')}`,
        // No network: every request to a proxy that is not there, every
        // name to nothing.
        '--proxy-server=socks5://127.0.0.1:9',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--no-first-run',
        '--no-default-browser-check',
        '--metrics-recording-only',
        '--mute-audio',
        '--renderer-process-limit=1',
        '--no-pdf-header-footer',
        // Chromium refuses its own sandbox as root (development
        // containers); production runs the API as another user.
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        `--print-to-pdf=${out}`,
        `file://${page}`,
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.browser!, args, { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir } });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new ServiceUnavailableException({ code: 'pdf_timeout' }));
        }, PDF_TIMEOUT_MS);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!existsSync(out)) throw new ServiceUnavailableException({ code: 'pdf_failed' });
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
      this.done();
    }
  }
}
