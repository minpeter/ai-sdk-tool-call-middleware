import {
  findAllInnerRanges as findRanges,
  findFirstTopLevelRange as findTopLevelRange,
} from "./inner-ranges";
import { extractRawInner as extractInner } from "./raw-content";
import { countTagOccurrences as countOccurrences } from "./tag-occurrences";

export const countTagOccurrences = countOccurrences;
export const extractRawInner = extractInner;
export const findAllInnerRanges = findRanges;
export const findFirstTopLevelRange = findTopLevelRange;
