import { csv, csvCell, csvFileName } from './csv.js';

describe('CSV files', () => {
  it('starts with a byte-order mark, quotes every cell and ends lines CRLF', () => {
    const file = csv(['Number', 'Title'], [['POL-GOV-001', 'Say "hello", then go'], [1, null]]);
    expect(file.charCodeAt(0)).toBe(0xfeff);
    expect(file.slice(1)).toBe(
      '"Number","Title"\r\n"POL-GOV-001","Say ""hello"", then go"\r\n"1",""\r\n',
    );
  });

  it('keeps Arabic and French as written', () => {
    expect(csvCell('ضبط الوثائق')).toBe('"ضبط الوثائق"');
    expect(csvCell('Maîtrise des documents')).toBe('"Maîtrise des documents"');
  });

  it('neutralises anything a spreadsheet would run as a formula', () => {
    for (const value of ['=1+1', '+1', '-2', '@SUM(A1)', '\t=1', '\r=1', '  =1', ' =1', '＝1', '＠x']) {
      expect(csvCell(value)).toBe(`"'${value}"`);
    }
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    // Text with those signs further in is left alone.
    expect(csvCell('PRC-SAF-001')).toBe('"PRC-SAF-001"');
    expect(csvCell('a = b')).toBe('"a = b"');
  });

  it('names a file in letters, digits and hyphens', () => {
    expect(csvFileName('acknowledgements-PRC-SAF-001-v2', '2026-11-27')).toBe(
      'acknowledgements-PRC-SAF-001-v2-2026-11-27.csv',
    );
    expect(csvFileName('a"b/c', '2026-11-27')).toBe('a-b-c-2026-11-27.csv');
  });
});
