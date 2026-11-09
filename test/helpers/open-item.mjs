// Exercise the actual input behavior: touch taps open, mouse double clicks open.
export async function openItem(locator, options = {}) {
  const touch = await locator.page().evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (touch) await locator.tap(options);
  else await locator.dblclick(options);
}
