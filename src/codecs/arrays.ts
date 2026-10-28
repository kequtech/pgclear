import type { PgArray } from '../types.js';

/** PostgreSQL text-array grammar. Bounds are validated, then intentionally omitted from JS values. */
export function parseArray(
  text: string,
  decode: (value: string) => unknown,
  delimiter = ',',
): unknown[] {
  let position = 0;
  const dimensions: number[] = [];
  function invalid(): never {
    throw new Error('Invalid PostgreSQL array.');
  }
  const space = () => {
    while (/\s/.test(text[position] ?? '') && position < text.length) position++;
  };
  space();
  while (text[position] === '[') {
    const match = /^\[([+-]?\d+):([+-]?\d+)\]/.exec(text.slice(position));
    if (!match || dimensions.length === 6) invalid();
    const lower = Number(match[1]),
      upper = Number(match[2]);
    if (
      ![lower, upper].every((n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) ||
      upper < lower
    )
      invalid();
    dimensions.push(upper - lower + 1);
    position += match[0].length;
  }
  if (dimensions.length && text[position++] !== '=') invalid();
  const element = (): unknown => {
    space();
    let value = '',
      escaped = false;
    if (text[position] === '"') {
      position++;
      let closed = false;
      while (position < text.length) {
        const char = text[position++]!;
        if (char === '"') {
          closed = true;
          break;
        }
        if (char === '\\') {
          if (position === text.length) invalid();
          value += text[position++]!;
        } else value += char;
      }
      if (!closed) invalid();
      space();
      if (text[position] !== delimiter && text[position] !== '}') invalid();
      return decode(value);
    }
    let significant = 0;
    while (position < text.length && text[position] !== delimiter && text[position] !== '}') {
      const char = text[position++]!;
      if (char === '{' || char === '"') invalid();
      if (char === '\\') {
        if (position === text.length) invalid();
        value += text[position++]!;
        significant = value.length;
        escaped = true;
      } else {
        value += char;
        if (!/\s/.test(char)) significant = value.length;
      }
    }
    value = value.slice(0, significant);
    if (!value) invalid();
    return !escaped && value.toUpperCase() === 'NULL' ? null : decode(value);
  };
  const array = (depth: number): { values: unknown[]; shape: number[] } => {
    space();
    if (depth > 6 || text[position++] !== '{') invalid();
    space();
    const values: unknown[] = [];
    if (text[position] === '}') {
      position++;
      if (depth !== 1) invalid();
      return { values, shape: [0] };
    }
    let childShape: number[] | undefined, nested: boolean | undefined;
    for (;;) {
      space();
      const childIsArray = text[position] === '{';
      if (nested !== undefined && nested !== childIsArray) invalid();
      nested = childIsArray;
      if (childIsArray) {
        const child = array(depth + 1);
        if (
          childShape &&
          (child.shape.length !== childShape.length ||
            child.shape.some((size, i) => size !== childShape![i]))
        )
          invalid();
        childShape = child.shape;
        values.push(child.values);
      } else values.push(element());
      space();
      const next = text[position++];
      if (next === '}') break;
      if (next !== delimiter) invalid();
    }
    return { values, shape: [values.length, ...(childShape ?? [])] };
  };
  const result = array(1);
  space();
  if (
    position !== text.length ||
    (dimensions.length &&
      (dimensions.length !== result.shape.length ||
        dimensions.some((size, i) => size !== result.shape[i])))
  )
    invalid();
  return result.values;
}

export function encodeArray<T>(values: PgArray<T>, encode: (value: T) => string): string {
  const visit = (items: PgArray<T>, depth: number): { text: string; shape: number[] } => {
    if (!Array.isArray(items) || depth > 6 || (depth > 1 && items.length === 0))
      throw new TypeError('Invalid PostgreSQL array dimensions.');
    const elements: string[] = [];
    let nested: boolean | undefined, childShape: number[] | undefined;
    for (const value of items) {
      const childIsArray = Array.isArray(value);
      if (nested !== undefined && nested !== childIsArray)
        throw new TypeError('Array dimensions must be rectangular.');
      nested = childIsArray;
      if (childIsArray) {
        const child = visit(value, depth + 1);
        if (
          childShape &&
          (child.shape.length !== childShape.length ||
            child.shape.some((size, i) => size !== childShape![i]))
        )
          throw new TypeError('Array dimensions must be rectangular.');
        childShape = child.shape;
        elements.push(child.text);
      } else if (value === null) elements.push('NULL');
      else {
        if (value === undefined) throw new TypeError('Array elements must be defined.');
        const text = encode(value as T);
        if (typeof text !== 'string' || text.includes('\0') || !text.isWellFormed())
          throw new TypeError('Invalid array element encoding.');
        elements.push('"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"');
      }
    }
    return { text: '{' + elements.join(',') + '}', shape: [items.length, ...(childShape ?? [])] };
  };
  return visit(values, 1).text;
}

/** Stable bootstrap array OIDs only; dynamic catalog/extension arrays remain unknown text. */
export const arrayElements: ReadonlyMap<number, number> = new Map([
  [143, 142],
  [199, 114],
  [210, 71],
  [270, 75],
  [271, 5069],
  [272, 81],
  [273, 83],
  [629, 628],
  [651, 650],
  [719, 718],
  [775, 774],
  [791, 790],
  [1000, 16],
  [1001, 17],
  [1002, 18],
  [1003, 19],
  [1005, 21],
  [1006, 22],
  [1007, 23],
  [1008, 24],
  [1009, 25],
  [1010, 27],
  [1011, 28],
  [1012, 29],
  [1013, 30],
  [1014, 1042],
  [1015, 1043],
  [1016, 20],
  [1017, 600],
  [1018, 601],
  [1019, 602],
  [1020, 603],
  [1021, 700],
  [1022, 701],
  [1027, 604],
  [1028, 26],
  [1034, 1033],
  [1040, 829],
  [1041, 869],
  [1115, 1114],
  [1182, 1082],
  [1183, 1083],
  [1185, 1184],
  [1187, 1186],
  [1231, 1700],
  [1263, 2275],
  [1270, 1266],
  [1561, 1560],
  [1563, 1562],
  [2201, 1790],
  [2207, 2202],
  [2208, 2203],
  [2209, 2204],
  [2210, 2205],
  [2211, 2206],
  [2949, 2970],
  [2951, 2950],
  [3221, 3220],
  [3643, 3614],
  [3644, 3642],
  [3645, 3615],
  [3735, 3734],
  [3770, 3769],
  [3807, 3802],
  [3905, 3904],
  [3907, 3906],
  [3909, 3908],
  [3911, 3910],
  [3913, 3912],
  [3927, 3926],
  [4073, 4072],
  [4090, 4089],
  [4097, 4096],
  [4192, 4191],
  [5039, 5038],
  [6150, 4451],
  [6151, 4532],
  [6152, 4533],
  [6153, 4534],
  [6155, 4535],
  [6157, 4536],
]);
