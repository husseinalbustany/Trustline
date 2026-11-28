import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { qrModules, qrSvg } from './qr.js';

/**
 * The port against the original: Project Nayuki's generator as the web
 * app's `qrcode.react` ships it (its printed QR codes come from it), taken
 * from the installed package and run as it is.
 */
function original() {
  const store = resolve(__dirname, '../../../../../node_modules/.pnpm');
  const dir = readdirSync(store).find((d) => d.startsWith('qrcode.react@'));
  if (!dir) throw new Error('qrcode.react is not installed: the reference is missing');
  const source = readFileSync(join(store, dir, 'node_modules/qrcode.react/lib/esm/index.js'), 'utf8');
  const start = source.indexOf('var qrcodegen;');
  const end = source.indexOf('var qrcodegen_default');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('assert', `${source.slice(start, end)}; return qrcodegen;`)((ok: boolean) => {
    if (!ok) throw new Error('assertion');
  }) as { QrCode: { encodeBinary(data: number[], ecl: unknown): { getModules(): boolean[][] }; Ecc: { MEDIUM: unknown } } };
}

describe('the QR code of a printed document', () => {
  const qrcodegen = original();
  const links = [
    'https://trustline.example/en/policies/0b5a6c1e-8a0f-4d2e-9c1a-3f2b7e6d5c4a',
    'https://hospital.example.org/ar/policies/12345678-1234-1234-1234-123456789abc?version=3',
    'x',
    'https://a.example/' + 'p'.repeat(180),
  ];
  it.each(links)('draws the modules the original draws: %s', (link) => {
    const theirs = qrcodegen.QrCode.encodeBinary([...Buffer.from(link, 'utf8')], qrcodegen.QrCode.Ecc.MEDIUM).getModules();
    expect(qrModules(link)).toEqual(theirs);
  });

  it('is an SVG of dark squares on a light ground, with its quiet zone', () => {
    const svg = qrSvg('https://trustline.example/x');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 (\d+) \1"/);
    expect(svg).not.toMatch(/<script|href=/);
  });
});
