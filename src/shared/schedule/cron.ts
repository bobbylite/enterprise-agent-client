const PART = /^(\*|\d+|\d+-\d+)(\/\d+)?$/;

export function assertValidCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expressions need 5 fields: minute hour day month weekday.');
  }
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  fields.forEach((field, index) => {
    const [min, max] = ranges[index];
    for (const part of field.split(',')) {
      if (!PART.test(part)) {
        throw new Error(`Invalid cron field "${field}".`);
      }
      const body = part.split('/')[0];
      if (body === '*') continue;
      const [startText, endText] = body.split('-');
      const start = Number(startText);
      const end = endText === undefined ? start : Number(endText);
      if (start < min || end > max || start > end) {
        throw new Error(`Cron field "${field}" is outside ${min}-${max}.`);
      }
    }
  });
}

export function cronMatches(expression: string, date: Date): boolean {
  assertValidCron(expression);
  const fields = expression.trim().split(/\s+/);
  if (!matchField(fields[0], date.getMinutes(), 0, 59)) return false;
  if (!matchField(fields[1], date.getHours(), 0, 23)) return false;
  if (!matchField(fields[3], date.getMonth() + 1, 1, 12)) return false;
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  const dom = matchField(fields[2], date.getDate(), 1, 31);
  const dow = matchField(fields[4], date.getDay(), 0, 6);
  if (domRestricted && dowRestricted) return dom || dow;
  return dom && dow;
}

export function minuteKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((part) => matchPart(part, value, min, max));
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  const [body, stepText] = part.split('/');
  const step = stepText ? Number(stepText) : 1;
  if (!Number.isInteger(step) || step <= 0) return false;
  let start = min;
  let end = max;
  if (body !== '*') {
    const [startText, endText] = body.split('-');
    start = Number(startText);
    end = endText === undefined ? start : Number(endText);
  }
  if (value < start || value > end) return false;
  return (value - start) % step === 0;
}
