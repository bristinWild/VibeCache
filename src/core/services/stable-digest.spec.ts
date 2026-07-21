import { stableDigest, stableJson } from './stable-digest';

describe('stableDigest', () => {
  it('is independent of object key insertion order', () => {
    expect(stableDigest({ beta: 2, alpha: { delta: 4, charlie: 3 } })).toBe(
      stableDigest({ alpha: { charlie: 3, delta: 4 }, beta: 2 }),
    );
  });

  it('retains array order and meaningful values', () => {
    expect(stableDigest({ values: ['a', 'b'] })).not.toBe(
      stableDigest({ values: ['b', 'a'] }),
    );
  });

  it('omits undefined object properties in canonical JSON', () => {
    expect(stableJson({ beta: undefined, alpha: true })).toBe('{"alpha":true}');
  });
});
