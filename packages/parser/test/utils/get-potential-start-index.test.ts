import { describe, test, expect } from 'vitest';
import { getPotentialStartIndex } from '../../src/utils/get-potential-start-index';

describe('getPotentialStartIndex', () => {
  // 1. Tag Found
  describe('Tag Found', () => {
    test('should return the correct starting index when tag is present', () => {
      expect(getPotentialStartIndex('Hello <tag> world', '<tag>')).toBe(6);
      expect(getPotentialStartIndex('<tag>Hello world', '<tag>')).toBe(0);
      expect(getPotentialStartIndex('Hello world<tag>', '<tag>')).toBe(11);
    });

    test('should return the index of the first occurrence if tag appears multiple times', () => {
      expect(getPotentialStartIndex('Hello <tag> world <tag>', '<tag>')).toBe(6);
    });
  });

  // 2. Tag Not Found
  describe('Tag Not Found', () => {
    test('should return null if tag is not present and no partial suffix match', () => {
      expect(getPotentialStartIndex('Hello world', '<tag>')).toBe(null);
      expect(getPotentialStartIndex('Hello <ta', '<tag>')).toBe(null); // Different from partial suffix match at end
      expect(getPotentialStartIndex('Hello <nomatch>', '<tag>')).toBe(null);
    });
  });

  // 3. Partial Match at End of Buffer
  describe('Partial Match at End of Buffer', () => {
    test('should return index if buffer ends with a prefix of the tag', () => {
      expect(getPotentialStartIndex('Hello <t', '<tag>')).toBe(6);
      expect(getPotentialStartIndex('Hello <ta', '<tag>')).toBe(6);
      expect(getPotentialStartIndex('Hello <tag', '<tag>')).toBe(6); // This is a full match, handled by directIndex first
    });

    test('should return index for the longest suffix that is a prefix of the tag', () => {
      // e.g. buffer "abc", tag "bcd" -> no match (null)
      // e.g. buffer "abc", tag "cde" -> i=2, suffix "c", "cde".startsWith("c") -> returns 2
      expect(getPotentialStartIndex('Hello abc', 'cde')).toBe(8); // "c" is suffix of "Hello abc", prefix of "cde"
      expect(getPotentialStartIndex('Hello ab', 'abc')).toBe(6);  // "ab" is suffix of "Hello ab", prefix of "abc"
    });
    
    test('should return null if no part of tag is at the end, even if tag is elsewhere', () => {
      // This tests that partial matching only happens at the very end of the buffer
      expect(getPotentialStartIndex('Partial <ta then other text', '<tag>')).toBe(null);
    });

    test('full match should take precedence over partial suffix match logic', () => {
      // If "<tag>" is fully present, its index should be returned, not a later partial match.
      // The current implementation checks directIndex first, so this is covered.
      expect(getPotentialStartIndex('Full <tag> then <t', '<tag>')).toBe(5);
      expect(getPotentialStartIndex('<tag> then <t', '<tag>')).toBe(0);
    });
    
    test('should return null if only a non-prefix part of the tag matches at the end', () => {
      expect(getPotentialStartIndex('Hello ag', '<tag>')).toBe(null); // "ag" is not a prefix of "<tag>"
    });
  });

  // 4. Empty Buffer
  describe('Empty Buffer', () => {
    test('should return null if buffer is empty and tag is not empty', () => {
      expect(getPotentialStartIndex('', '<tag>')).toBe(null);
    });
  });

  // 5. Empty Tag
  describe('Empty Tag', () => {
    test('should return null if tag is empty', () => {
      expect(getPotentialStartIndex('Hello world', '')).toBe(null);
      expect(getPotentialStartIndex('', '')).toBe(null);
    });
  });

  // 6. Tag at Beginning/End of Buffer
  describe('Tag at Beginning/End of Buffer', () => {
    test('should return 0 if tag is at the beginning of the buffer', () => {
      expect(getPotentialStartIndex('<tag>Hello world', '<tag>')).toBe(0);
    });

    test('should return correct index if tag is at the end of the buffer', () => {
      expect(getPotentialStartIndex('Hello world<tag>', '<tag>')).toBe(11);
    });
    
    test('should handle partial match when tag is longer than buffer and buffer is prefix of tag', () => {
      expect(getPotentialStartIndex('<t', '<tag>')).toBe(0);
      expect(getPotentialStartIndex('<ta', '<tag>')).toBe(0);
    });

    test('should return null if buffer is a suffix but not a prefix of tag', () => {
      expect(getPotentialStartIndex('ag>', '<tag>')).toBe(null); // "ag>" is not a prefix
    });
  });

  // Additional edge cases
  describe('Additional Edge Cases', () => {
    test('buffer and tag are identical', () => {
      expect(getPotentialStartIndex('<tag>', '<tag>')).toBe(0);
    });

    test('buffer is shorter than tag but is a prefix', () => {
      expect(getPotentialStartIndex('<ta', '<tag>')).toBe(0);
    });

    test('buffer is shorter than tag and not a prefix', () => {
      expect(getPotentialStartIndex('ta', '<tag>')).toBe(null);
    });
    
    test('buffer contains parts of tag but not as a continuous prefix from end', () => {
      expect(getPotentialStartIndex('Hello <t then ag>', '<tag>')).toBe(null);
    });

    test('complex scenario with multiple partials and one full match', () => {
        // The first full match should be returned
        expect(getPotentialStartIndex('abc <tag> def <t', '<tag>')).toBe(4);
    });

    test('complex scenario with only partials, longest suffix prefix should be chosen', () => {
        // text = "abc <ta def <tag" , tag = "<tag>content"
        // suffix "<tag" is prefix of "<tag>content" -> index of "<tag"
        // suffix "<ta def <tag" is not prefix
        // suffix "g" is not prefix
        expect(getPotentialStartIndex('abc <ta def <tag', '<tag>content')).toBe(13);
    });
  });
});
