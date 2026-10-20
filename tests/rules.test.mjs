#!/usr/bin/env node
/**
 * rules.test.mjs —— 「别看大肥鱼了！」判定库的零依赖单元测试
 *
 * 运行：
 *   node bili-bot-shield/tests/rules.test.mjs
 *
 * 说明：
 *   - src/rules.js 是 UMD/CJS，这里用 createRequire 以 CommonJS 方式加载，
 *     这样浏览器与 Node 跑的是同一份代码。
 *   - 每个断言都带中文 label；任何失败 process.exitCode = 1。
 *   - 本文件只读取 rules.js，不修改它；若实际行为与预期不符，
 *     会把 score / threshold / reasons 全部打印出来，便于反馈给维护者。
 */

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const R = require('../src/rules.js');

let passed = 0;
const failures = [];

/** 跑一个测试；失败只记录，不中断其余测试 */
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push({ label, message: err.message });
    console.log(`  ✗ ${label}`);
    console.log(`      ${String(err.message).replace(/\n/g, '\n      ')}`);
  }
}

/** 便于在失败信息里看清实际打分 */
function describe(r) {
  return `score=${r.score}, threshold=${r.threshold}, hit=${r.hit}, reasons=${JSON.stringify(r.reasons)}`;
}

/** 用默认昵称构造一条顶层评论（默认 balanced 档） */
function score(message, uname = '热心网友', extra = {}) {
  return R.scoreComment(Object.assign({ message, uname }, extra));
}

/** 用指定档位打分（level 是 scoreComment 的第二个参数，不是评论字段） */
function scoreLevel(message, level, uname = '热心网友') {
  return R.scoreComment({ message, uname }, { level });
}

/** 断言在指定档位命中（同时核对档位阈值确实取自 rules.js） */
function expectHit(r, level) {
  assert.equal(r.threshold, R.THRESHOLDS[level], `档位 ${level} 的阈值应为 ${R.THRESHOLDS[level]}，实际 ${r.threshold}`);
  assert.ok(r.hit, `期望 ${level} 档命中，实际未命中（${describe(r)}）`);
}

/** 断言在指定档位不命中 */
function expectMiss(r, level) {
  assert.equal(r.threshold, R.THRESHOLDS[level], `档位 ${level} 的阈值应为 ${R.THRESHOLDS[level]}，实际 ${r.threshold}`);
  assert.ok(!r.hit, `期望 ${level} 档不命中，实际命中（${describe(r)}）`);
}

console.log('rules.js 判定库测试');
console.log(`版本：${R.VERSION}\n`);

/* ------------------------------------------------------------------ *
 * 1-2. 典型机器人评论：顶层 @ 开头 + AI 推荐语，balanced 应命中
 * ------------------------------------------------------------------ */

test('1. 典型机器人评论 A（@小明 这期把 DeepSeek Harness 的插件讲清楚了，值得看）balanced 命中', () => {
  const r = score('@小明 这期把 DeepSeek Harness 的插件讲清楚了，值得看');
  expectHit(r, 'balanced');
  assert.ok(r.reasons.includes('顶层评论以@昵称开头'), `应命中「顶层评论以@昵称开头」，实际 reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(r.reasons.includes('含AI推荐语'), `应命中「含AI推荐语」，实际 reasons=${JSON.stringify(r.reasons)}`);
});

test('2. 典型机器人评论 B（@阿强 白饭这个视频整理得不错，推荐看看）balanced 命中', () => {
  const r = score('@阿强 白饭这个视频整理得不错，推荐看看');
  expectHit(r, 'balanced');
  assert.ok(r.reasons.includes('顶层评论以@昵称开头'), `应命中「顶层评论以@昵称开头」，实际 reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(r.reasons.includes('符合@+推荐结构'), `应命中「符合@+推荐结构」，实际 reasons=${JSON.stringify(r.reasons)}`);
});

/* ------------------------------------------------------------------ *
 * 3. 只有账号名像机器人：名字分（+3）单独不足以命中 balanced
 * ------------------------------------------------------------------ */

test('3. 只有账号名提示词（大肥鱼本鱼 + 正常正文）balanced 不命中', () => {
  const r = score('今天天气不错，出去走走', '大肥鱼本鱼');
  expectMiss(r, 'balanced');
  assert.ok(r.reasons.includes('账号名含提示词'), `应命中「账号名含提示词」，实际 reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(r.score < R.THRESHOLDS.balanced, `名字+正常正文应低于 balanced 阈值，实际 ${describe(r)}`);
});

/* ------------------------------------------------------------------ *
 * 4. 正常 @ 好友：只有 @，没有推荐语/模板长度，应不命中
 * ------------------------------------------------------------------ */

test('4. 正常 @ 好友（@小明 哈哈哈哈你看这个）不命中', () => {
  const r = score('@小明 哈哈哈哈你看这个', '普通用户');
  expectMiss(r, 'balanced');
  assert.ok(!r.reasons.includes('符合@+推荐结构'), `正常聊天不应命中「符合@+推荐结构」，实际 reasons=${JSON.stringify(r.reasons)}`);
});

/* ------------------------------------------------------------------ *
 * 5. 楼中楼回复：@ 是正常社交，且 isSub -3，应不命中
 * ------------------------------------------------------------------ */

test('5. 楼中楼回复（@楼主 说得好，isSub=true）不命中', () => {
  const r = R.scoreComment({ message: '@楼主 说得好', uname: '热心网友', isSub: true });
  expectMiss(r, 'balanced');
  assert.ok(r.reasons.includes('楼中楼回复'), `应命中「楼中楼回复」扣分，实际 reasons=${JSON.stringify(r.reasons)}`);
});

/* ------------------------------------------------------------------ *
 * 6. 超长且带链接的评论：>300 字 -2、链接 -2，应不命中
 * ------------------------------------------------------------------ */

test('6. 超长带链接评论（>300 字 + https://）不命中', () => {
  // 重复一段不含推荐语/口语词的中性长文，构造确定性 >300 字正文
  const longText =
    '安装过程还算顺利，配置项比预想的多，文档有些细节没写清楚，需要自己动手试一试才能明白。'.repeat(8) +
    ' https://example.com/abc';
  assert.ok(R.charLen(longText) > 300, `测试样本长度应 >300，实际 ${R.charLen(longText)}`);
  const r = score(longText, '普通用户');
  expectMiss(r, 'balanced');
  assert.ok(r.reasons.includes('超长评论'), `应命中「超长评论」扣分，实际 reasons=${JSON.stringify(r.reasons)}`);
  assert.ok(r.reasons.includes('含链接/图片/BV'), `应命中「含链接/图片/BV」扣分，实际 reasons=${JSON.stringify(r.reasons)}`);
});

/* ------------------------------------------------------------------ *
 * 7. 无 @ 的推荐语：短样本不杀，加长样本验证档位差异
 *   7a 短样本（需求原句，14 字，score=3）：balanced 不命中
 *   7b 短样本：aggressive 也不命中（3 < 4），固定“短推荐语不杀”
 *   7c 加长样本（30 字，score=4）：balanced 不命中、aggressive 命中
 * ------------------------------------------------------------------ */

test('7a. 短样本「这期视频真不错，一口气看完的」（14 字）balanced 不命中', () => {
  const r = score('这期视频真不错，一口气看完的', '普通用户');
  expectMiss(r, 'balanced');
  assert.ok(r.reasons.includes('含AI推荐语'), `应命中「含AI推荐语」，实际 reasons=${JSON.stringify(r.reasons)}`);
});

test('7b. 短样本「这期视频真不错，一口气看完的」（14 字）aggressive / conservative 均不命中（短推荐语不杀）', () => {
  const text = '这期视频真不错，一口气看完的';
  expectMiss(scoreLevel(text, 'aggressive', '普通用户'), 'aggressive');
  expectMiss(scoreLevel(text, 'conservative', '普通用户'), 'conservative');
  assert.ok(scoreLevel(text, 'aggressive', '普通用户').score < R.THRESHOLDS.aggressive, '短样本应低于 aggressive 阈值');
});

test('7c. 加长样本「这期视频真不错，一口气看完的，整体节奏很舒服，内容也挺有意思」（30 字）balanced 不命中、aggressive 命中', () => {
  const text = '这期视频真不错，一口气看完的，整体节奏很舒服，内容也挺有意思';
  expectMiss(scoreLevel(text, 'balanced', '普通用户'), 'balanced');
  expectHit(scoreLevel(text, 'aggressive', '普通用户'), 'aggressive');
});

/* ------------------------------------------------------------------ *
 * 8. 提问：应被「像真人提问」拉回阈值以下
 * ------------------------------------------------------------------ */

test('8. 提问（@小明 这期讲的是哪个插件？）balanced 不命中', () => {
  const r = score('@小明 这期讲的是哪个插件？', '热心网友');
  expectMiss(r, 'balanced');
  assert.ok(r.reasons.includes('像真人提问'), `应命中「像真人提问」扣分，实际 reasons=${JSON.stringify(r.reasons)}`);
});

/* ------------------------------------------------------------------ *
 * 9. 长度/标点规则 + normalize
 * ------------------------------------------------------------------ */

test('9a. 短评论不加长度分（长度规则只在 20-160 字才 +1）', () => {
  const r = score('嗯', '路人甲');
  assert.ok(!r.reasons.includes('长度符合机器人模板'), `短评论不应命中「长度符合机器人模板」，实际 reasons=${JSON.stringify(r.reasons)}`);
  expectMiss(r, 'balanced');
});

test('9b. normalize 去掉零宽字符并压缩空白', () => {
  assert.equal(R.normalize('你\u200b好  \u200c世界'), '你好 世界');
  assert.equal(R.normalize('  a\u200b b  '), 'a b');
  assert.equal(R.normalize(null), '');
  assert.equal(R.normalize(undefined), '');
});

/* ------------------------------------------------------------------ *
 * 10. matchesBlockedName：包含匹配，忽略大小写
 * ------------------------------------------------------------------ */

test('10. matchesBlockedName：包含匹配 / 忽略大小写 / 空数组为 false', () => {
  assert.equal(R.matchesBlockedName('大肥鱼', ['肥鱼']), true, '「大肥鱼」应被「肥鱼」包含匹配');
  assert.equal(R.matchesBlockedName('鲸鱼娘小号', ['鲸鱼娘']), true, '应支持包含匹配');
  assert.equal(R.matchesBlockedName('DSH-Token', ['TOKEN']), true, '应忽略大小写');
  assert.equal(R.matchesBlockedName('dsh-token', ['Token']), true, '应忽略大小写（反向）');
  assert.equal(R.matchesBlockedName('鲸鱼', []), false, '空名单应为 false');
  assert.equal(R.matchesBlockedName('', ['肥鱼']), false, '空昵称应为 false');
  assert.equal(R.matchesBlockedName(null, null), false, 'null 输入应为 false');
});

/* ------------------------------------------------------------------ *
 * 11. hasCluster：同模板聚类（字符 bigram Jaccard >= 0.35）
 * ------------------------------------------------------------------ */

test('11. hasCluster：3 条不同 UID 同模板为 true，2 条不同模板为 false', () => {
  const t1 = '@小明 这期把 DeepSeek Harness 的插件讲清楚了，值得看';
  const t2 = '@阿强 这期把 DeepSeek Harness 的插件讲明白了，值得看';
  const t3 = '@老王 这期把 DeepSeek Harness 的插件讲清楚了，值得一看';

  const items = [
    { uid: '2', text: t2 },
    { uid: '3', text: t3 }
  ];
  assert.equal(R.hasCluster(items, t1, '1'), true, '当前账号 + 2 个其它账号同模板，应为 true');

  const different = [
    { uid: '2', text: '今天天气不错，出去走走' },
    { uid: '3', text: '哈哈哈哈哈这个太草了' }
  ];
  assert.equal(R.hasCluster(different, t1, '1'), false, '正文完全不同的 2 条，应为 false');

  // 同一 UID 的重复评论不应凑数
  assert.equal(R.hasCluster([{ uid: '1', text: t1 }, { uid: '2', text: t2 }], t1, '1'), false, '同一 UID 不算多个账号，应为 false');

  // 太短的文本不参与聚类（bigram 少于 6 个）
  assert.equal(R.hasCluster([{ uid: '2', text: '说得好' }, { uid: '3', text: '说得好' }], '说得好', '1'), false, '过短文本应为 false');
});

/* ------------------------------------------------------------------ *
 * 12. 阈值表
 * ------------------------------------------------------------------ */

test('12. 阈值表：conservative=8 / balanced=6 / aggressive=4', () => {
  assert.deepEqual(R.THRESHOLDS, { conservative: 8, balanced: 6, aggressive: 4 });
  assert.equal(R.scoreComment({ message: '值得看' }, { level: 'conservative' }).threshold, 8);
  assert.equal(R.scoreComment({ message: '值得看' }, { level: 'aggressive' }).threshold, 4);
});

/* ------------------------------------------------------------------ *
 * 13. 空值 / null 输入不应抛异常
 * ------------------------------------------------------------------ */

test('13. 空值 / null 输入不抛异常', () => {
  assert.doesNotThrow(() => R.scoreComment());
  assert.doesNotThrow(() => R.scoreComment(null));
  assert.doesNotThrow(() => R.scoreComment({}));
  assert.doesNotThrow(() => R.scoreComment({ message: null, uname: null }));

  const empty = R.scoreComment(null);
  assert.equal(empty.score, 0);
  assert.equal(empty.hit, false);

  assert.equal(R.normalize(), '');
  assert.equal(R.charLen(null), 0);
  assert.equal(R.matchesBlockedName(undefined, undefined), false);
  assert.equal(R.hasCluster(), false);
  assert.equal(R.hasCluster(null, null, null), false);
});

/* ------------------------------------------------------------------ *
 * 14. 人设式机器人评论（真实样本）vs 真人提问
 * ------------------------------------------------------------------ */

test('14a. 疑似 AI 人设口吻（主人/本鱼/🐟）在平衡档命中', () => {
  const r = score(
    '这个路子本鱼眼熟🐟 每天替主人翻一轮，看到好玩的就叼回去——插件写得挺好，就是别把本鱼刷到忘了回家。',
    '大肥鱼小满'
  );
  expectHit(r, 'balanced');
  assert.ok(r.reasons.includes('疑似AI人设口吻'), '应命中人设信号');
});

test('14b. 真人提问（没有 @、没有推荐语、带「吗」）平衡档不命中', () => {
  const r = score(
    '有没有用过的老哥说一下这样一天得花多少钱，大概在谷峰时段跑两小时的话',
    '普通用户'
  );
  expectMiss(r, 'balanced');
});

/* ------------------------------------------------------------------ *
 * 边界样本（已知的「可接受误伤」，不视为失败）
 * 这两条是正常用户也可能发出的内容，但当前启发式规则会判为命中。
 * 设计上通过「折叠（而不是删除）+ 白名单 + 手动撤销」来兜底。
 * 这里断言它们当前确实命中，用于记录误伤边界；规则收紧后如不再命中，
 * 属于合理调整，可同步更新本段注释与断言。
 * ------------------------------------------------------------------ */

test('E1. 边界样本 @小明 这个视频讲得挺好的，推荐看看（当前命中，可接受误伤）', () => {
  const r = score('@小明 这个视频讲得挺好的，推荐看看', '普通用户');
  expectHit(r, 'balanced');
});

test('E2. 边界样本 @好友 这期视频不错，推荐看看（当前命中，可接受误伤）', () => {
  const r = score('@好友 这期视频不错，推荐看看', '普通用户');
  expectHit(r, 'balanced');
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('');
if (failures.length === 0) {
  console.log(`✓ ${passed} 通过`);
} else {
  console.log(`✗ ${passed} 通过，${failures.length} 失败：`);
  for (const f of failures) console.log(`  - ${f.label}`);
  console.log('\n请把上面的 score / reasons 反馈给 rules.js 维护者；不要为了测试通过而改 rules.js 的期望值。');
  process.exitCode = 1;
}
