const ROUNDING = Object.freeze({
  DOWN: "DOWN",
  HALF_UP: "HALF_UP",
});

const POW10 = [1n];

function pow10(exponent) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 10000) {
    throw new RangeError(`Invalid decimal exponent: ${exponent}`);
  }
  for (let index = POW10.length; index <= exponent; index += 1) {
    POW10[index] = POW10[index - 1] * 10n;
  }
  return POW10[exponent];
}

function parseDecimal(value) {
  const source = String(value ?? "").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new TypeError(`Invalid decimal value: ${source}`);

  const negative = match[1] === "-";
  const integer = match[2];
  const fraction = match[3] || "";
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) {
    throw new RangeError("Decimal exponent is out of range");
  }

  let coefficient = BigInt(`${integer}${fraction}` || "0");
  if (negative) coefficient = -coefficient;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return normalizeParts({ coefficient, scale });
}

function normalizeParts({ coefficient, scale }) {
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  let nextCoefficient = coefficient;
  let nextScale = scale;
  while (nextScale > 0 && nextCoefficient % 10n === 0n) {
    nextCoefficient /= 10n;
    nextScale -= 1;
  }
  return { coefficient: nextCoefficient, scale: nextScale };
}

function format({ coefficient, scale }) {
  const normalized = normalizeParts({ coefficient, scale });
  const negative = normalized.coefficient < 0n;
  let digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return `${negative ? "-" : ""}${digits}`;
  if (digits.length <= normalized.scale) {
    digits = `${"0".repeat(normalized.scale - digits.length + 1)}${digits}`;
  }
  const split = digits.length - normalized.scale;
  return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function align(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return {
    scale,
    a: a.coefficient * pow10(scale - a.scale),
    b: b.coefficient * pow10(scale - b.scale),
  };
}

export function normalizeDecimal(value) {
  return format(parseDecimal(value));
}

export function addDecimal(left, right) {
  const aligned = align(left, right);
  return format({ coefficient: aligned.a + aligned.b, scale: aligned.scale });
}

export function subtractDecimal(left, right) {
  const aligned = align(left, right);
  return format({ coefficient: aligned.a - aligned.b, scale: aligned.scale });
}

export function multiplyDecimal(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return format({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
}

export function divideDecimal(left, right, { scale = 18, rounding = ROUNDING.HALF_UP } = {}) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (b.coefficient === 0n) throw new RangeError("Division by zero");
  const negative = (a.coefficient < 0n) !== (b.coefficient < 0n);
  let numerator = a.coefficient < 0n ? -a.coefficient : a.coefficient;
  let denominator = b.coefficient < 0n ? -b.coefficient : b.coefficient;
  const exponent = b.scale + scale - a.scale;
  if (exponent >= 0) numerator *= pow10(exponent);
  else denominator *= pow10(-exponent);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (rounding === ROUNDING.HALF_UP && remainder * 2n >= denominator) quotient += 1n;
  if (negative) quotient = -quotient;
  return format({ coefficient: quotient, scale });
}

export function compareDecimal(left, right) {
  const aligned = align(left, right);
  if (aligned.a === aligned.b) return 0;
  return aligned.a > aligned.b ? 1 : -1;
}

export function percentageOf(amount, percent) {
  return divideDecimal(multiplyDecimal(amount, percent), "100", { scale: 18 });
}
