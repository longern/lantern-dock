// Touch taps and album clicks open immediately. File rows need a mouse double click.
export async function openItem(locator, options = {}) {
  const touch = await locator
    .page()
    .evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (touch) await locator.tap(options);
  else if (await locator.evaluate((node) => node.matches(".album-preview")))
    await locator.click(options);
  else await locator.dblclick(options);
}
