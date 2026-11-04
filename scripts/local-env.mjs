// Accept the wizard's JSON-quoted values and the existing single-quoted examples.
export function parseLocalVariables(source) {
  const values = {};
  for (const line of source.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'"))
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
