export async function favoriteItem(locator) {
  await locator.focus();
  await locator.press("Space");
  const actions = locator.page().getByRole("toolbar", { name: /^(所选项目操作|Selected item actions)$/ });
  await actions.getByRole("button", { name: /^(收藏所选项目|取消收藏所选项目|Add selected items to favorites|Remove selected items from favorites)$/ }).click();
  const cancel = actions.getByRole("button", { name: /^(取消选择|Cancel selection)$/ });
  if (await cancel.count()) await cancel.click();
}
