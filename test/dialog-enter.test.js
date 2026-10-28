// 弹层里"回车 = 提交"这一条规则：该提交的提交，输入法上屏与焦点在键上的不抢。
const { test } = require('node:test');
const assert = require('node:assert');
const { enterSubmits } = require('../web/src/lib/dialog-enter.js');

const ev = (over = {}) => {
  const seen = { prevented: false };
  return {
    event: Object.assign({
      isComposing: false,
      keyCode: 13,
      target: null,
      preventDefault() { seen.prevented = true; },
    }, over),
    seen,
  };
};

test('焦点不在键上：回车提交一次，并挡掉浏览器默认行为', () => {
  let runs = 0;
  const { event, seen } = ev({ target: { closest: () => null } });
  enterSubmits(() => { runs += 1; })(event);
  assert.strictEqual(runs, 1);
  assert.strictEqual(seen.prevented, true, '没 preventDefault：回车还会顺带触发别的东西（如表单默认提交）');
});

test('中文输入法上屏那一发回车不许提交（isComposing 与 keyCode 229 两种报法都挡）', () => {
  for (const over of [{ isComposing: true }, { keyCode: 229 }]) {
    let runs = 0;
    const { event } = ev({ target: { closest: () => null }, ...over });
    enterSubmits(() => { runs += 1; })(event);
    assert.strictEqual(runs, 0, `${JSON.stringify(over)} 那一发不该提交`);
  }
});

test('焦点落在键上（如「取消」）时不抢：那一下由浏览器按那颗键', () => {
  let runs = 0;
  const { event } = ev({ target: { closest: (sel) => (sel === 'button' ? { tagName: 'BUTTON' } : null) } });
  enterSubmits(() => { runs += 1; })(event);
  assert.strictEqual(runs, 0);
});

test('拿不到 target 也要提交（回车是用户按的，不是键自己发的）', () => {
  let runs = 0;
  const { event } = ev({ target: null });
  enterSubmits(() => { runs += 1; })(event);
  assert.strictEqual(runs, 1);
});
