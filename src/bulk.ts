/** One business from a pasted list. */
export interface BulkEntry { name: string; address: string; city: string }

const STATE_CODES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const STATE_TAIL = new RegExp("\\s+(" + STATE_CODES.join("|") + ")(\\s+\\d{5}(-\\d{4})?)?$");
const JUNK = /^(usa|us|united states|\d{5}(-\d{4})?)$/i;
const isStatePart = (p: string) => JUNK.test(p) || new RegExp("^(" + STATE_CODES.join("|") + ")(\\s+\\d{5}(-\\d{4})?)?$").test(p);
const startsLikeStreet = (p: string) => /^(\d|p\.?\s?o\.?\s+box|box\s)/i.test(p);

/**
 * Turns a pasted list into stops. Accepted per line:
 *   Business Name, 123 Main St, Town            (commas)
 *   Business Name - 123 Main St, Town, ID 83702 (dash after the name)
 *   Business Name<TAB>123 Main St<TAB>Town      (columns copied from a spreadsheet)
 * or blocks separated by a blank line, with the name on the first line and the address below
 * (the way Google Maps and most websites lay them out).
 */
export function parseBulk(text: string): BulkEntry[] {
  const out: BulkEntry[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // Name on its own line, address on the next line(s).
    if (lines.length > 1 && !lines[0].includes("\t") && !lines[0].includes(",") && startsLikeStreet(lines[1])) {
      out.push(fromParts(lines[0], lines.slice(1).flatMap(splitCommas)));
      continue;
    }
    for (const line of lines) {
      const e = fromLine(line);
      if (e) out.push(e);
    }
  }
  return out.filter((e) => e.name);
}

function splitCommas(s: string): string[] {
  return s.split(",").map((p) => p.trim()).filter(Boolean);
}

function fromLine(line: string): BulkEntry | null {
  const clean = line.replace(/^\s*(\d+[.)]|[-*•])\s+/, ""); // list numbering or bullets
  if (clean.includes("\t")) {
    const cols = clean.split("\t").map((c) => c.trim()).filter(Boolean);
    return cols.length ? fromParts(cols[0], cols.slice(1).flatMap(splitCommas)) : null;
  }
  const dash = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && startsLikeStreet(dash[2])) return fromParts(dash[1], splitCommas(dash[2]));
  const parts = splitCommas(clean);
  return parts.length ? fromParts(parts[0], parts.slice(1)) : null;
}

function fromParts(name: string, rest: string[]): BulkEntry {
  const parts = rest.filter((p) => !isStatePart(p));
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(STATE_TAIL, "").trim();
  let address = "", city = "";
  if (parts.length >= 2) { city = parts.pop()!; address = parts.join(", "); }
  else if (parts.length === 1) { if (startsLikeStreet(parts[0])) address = parts[0]; else city = parts[0]; }
  return { name: name.trim(), address, city };
}
