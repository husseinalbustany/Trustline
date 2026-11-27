import { canonicalJson, contentHash } from './signatures.js';

describe('what a signature hashes', () => {
  it('is the same content in any key order, and different for any change', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ ...a, b: 2 })).not.toBe(contentHash(a));
    // Order in a list is meaning.
    expect(contentHash({ a: [2, 1] })).not.toBe(contentHash({ a: [1, 2] }));
    // Every character counts, in any script.
    expect(contentHash({ t: 'وثيقة' })).not.toBe(contentHash({ t: 'وثيقه' }));
  });

  it('leaves out what is undefined and refuses what is not JSON', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});
