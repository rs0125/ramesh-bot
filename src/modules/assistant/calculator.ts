/** Bounded decimal arithmetic. No eval, JavaScript functions, variables or network access. */
import { z } from 'zod';

const unit = z.enum(['sqft', 'sqm', 'acre', 'hectare', 'ft', 'm']);
export const calculateInput = z
  .object({
    expression: z.string().trim().min(1).max(512),
    decimal_places: z.number().int().min(0).max(12).optional(),
    conversion: z.object({ from: unit, to: unit }).strict().optional(),
  })
  .strict();

type Fraction = { n: bigint; d: bigint };
function fraction(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw new Error('DIVISION_BY_ZERO');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n.toString().length > 2000 || d.toString().length > 2000)
    throw new Error('CALCULATION_LIMIT');
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
function decimal(text: string): Fraction {
  const [base = '', exponent = '0'] = text.toLowerCase().split('e');
  const power = Number(exponent);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 100) throw new Error('CALCULATION_LIMIT');
  const [whole = '', part = ''] = base.split('.');
  const scale = part.length - power;
  const n = BigInt(whole + part);
  return scale >= 0 ? fraction(n, 10n ** BigInt(scale)) : fraction(n * 10n ** BigInt(-scale));
}
function multiply(a: Fraction, b: Fraction) {
  return fraction(a.n * b.n, a.d * b.d);
}
function divide(a: Fraction, b: Fraction) {
  return fraction(a.n * b.d, a.d * b.n);
}

function evaluate(expression: string): Fraction {
  const tokens: string[] = [];
  const pattern = /\s*((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*/^])/y;
  let offset = 0;
  while (offset < expression.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match || tokens.length >= 128) throw new Error('INVALID_EXPRESSION');
    tokens.push(match[1]!);
    offset = pattern.lastIndex;
  }
  let cursor = 0;
  const peek = () => tokens[cursor];
  const atom = (): Fraction => {
    const token = tokens[cursor++];
    if (token === '(') {
      const value = sum();
      if (tokens[cursor++] !== ')') throw new Error('INVALID_EXPRESSION');
      return value;
    }
    if (!token || !/^[\d.]/.test(token)) throw new Error('INVALID_EXPRESSION');
    return decimal(token);
  };
  const power = (): Fraction => {
    const value = atom();
    if (peek() !== '^') return value;
    cursor++;
    const exponent = unary();
    if (exponent.d !== 1n || exponent.n < -100n || exponent.n > 100n)
      throw new Error('INVALID_EXPONENT');
    if (value.n === 0n && exponent.n === 0n) throw new Error('INVALID_EXPONENT');
    const e = exponent.n < 0n ? -exponent.n : exponent.n;
    // Bound intermediate exponentiation before allocating a large bigint.
    if (Math.max(value.n.toString().length, value.d.toString().length) * Number(e) > 2000)
      throw new Error('CALCULATION_LIMIT');
    return exponent.n < 0n
      ? fraction(value.d ** e, value.n ** e)
      : fraction(value.n ** e, value.d ** e);
  };
  const unary = (): Fraction => {
    if (peek() === '+' || peek() === '-') {
      const sign = tokens[cursor++];
      const value = unary();
      return sign === '-' ? { n: -value.n, d: value.d } : value;
    }
    return power();
  };
  const product = (): Fraction => {
    let value = unary();
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[cursor++];
      const right = unary();
      value = operator === '*' ? multiply(value, right) : divide(value, right);
    }
    return value;
  };
  const sum = (): Fraction => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[cursor++];
      const right = product();
      value = fraction(
        value.n * right.d + (operator === '+' ? 1n : -1n) * right.n * value.d,
        value.d * right.d,
      );
    }
    return value;
  };
  const value = sum();
  if (cursor !== tokens.length) throw new Error('INVALID_EXPRESSION');
  return value;
}

const units = {
  sqft: ['area', '0.09290304'],
  sqm: ['area', '1'],
  acre: ['area', '4046.8564224'],
  hectare: ['area', '10000'],
  ft: ['length', '0.3048'],
  m: ['length', '1'],
} as const;

export function calculate(args: z.infer<typeof calculateInput>) {
  let value = evaluate(args.expression);
  if (args.conversion) {
    const from = units[args.conversion.from],
      to = units[args.conversion.to];
    if (from[0] !== to[0]) throw new Error('INCOMPATIBLE_UNITS');
    value = divide(multiply(value, decimal(from[1])), decimal(to[1]));
  }
  const places = args.decimal_places ?? 6;
  const negative = value.n < 0n;
  const scaled = (negative ? -value.n : value.n) * 10n ** BigInt(places);
  const remainder = scaled % value.d;
  const rounded = scaled / value.d + (remainder * 2n >= value.d ? 1n : 0n);
  const digits = rounded.toString().padStart(places + 1, '0');
  if (digits.length > 120) throw new Error('CALCULATION_LIMIT');
  const text = places
    ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '')
    : digits;
  return {
    expression: args.expression,
    value: `${negative && rounded !== 0n ? '-' : ''}${text}`,
    decimal_places: places,
    rounded: remainder !== 0n,
    rounding: 'nearest; ties away from zero',
    ...(args.conversion ? { conversion: args.conversion, unit: args.conversion.to } : {}),
  };
}
