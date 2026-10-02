/** Serialize private dotenv values literally, including JSON signing keys and PEM certificates. */
import { parse } from 'dotenv';

export function privateEnvironment(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('INVALID_ENVIRONMENT_NAME');
    for (const quote of ["'", '`', '"']) {
      const line = `${name}=${quote}${value}${quote}`;
      const parsed = parse(line);
      if (Object.keys(parsed).length === 1 && parsed[name] === value) return line;
    }
    throw new Error('ENVIRONMENT_VALUE_CANNOT_BE_QUOTED');
  });
  const result = `${lines.join('\n')}\n`;
  const parsed = parse(result);
  if (
    Object.keys(parsed).length !== Object.keys(values).length ||
    Object.entries(values).some(([name, value]) => parsed[name] !== value)
  )
    throw new Error('ENVIRONMENT_ROUNDTRIP_FAILED');
  return result;
}
