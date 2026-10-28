// 弹层里"回车 = 按那颗主键"（确认 / 新建 / 重命名 / 移动 / 删除 / 清空都一样）。
// 两条不抢：① 中文输入法上屏那一发回车（keydown 时 isComposing 仍为真）；
// ② 焦点落在别的键上（如「取消」）—— 那一下该由浏览器自己按那颗键，抢了会变成"又取消又提交"。
export function enterSubmits(run) {
  return (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const t = event.target;
    if (t && t.closest && t.closest('button')) return;
    event.preventDefault();
    run();
  };
}
