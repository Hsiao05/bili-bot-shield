/**
 * tests/corpus-eval.mjs —— 用真实评论区语料评估规则
 *
 * 语料：tests/real-corpus.json（34 条机器人 + 12 条真人，来自两批 B 站评论区手工标注）
 * 用法：node tests/corpus-eval.mjs
 *
 * 输出三档的命中率/误伤数；平衡档召回低于 30/34 时 exit 1（方便改规则后自查）。
 * 注意：真人样本里有少量「像机器人的真人」和「像真人的机器人」，标注本身有模糊地带，
 *       所以这里只做趋势评估，不追求 100%。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = require(path.join(HERE, '..', 'src', 'rules.js'));
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'real-corpus.json'), 'utf8'));

const LEVELS = ['conservative', 'balanced', 'aggressive'];
let balancedRecall = 0;

for (const level of LEVELS) {
  let botTotal = 0;
  let botHit = 0;
  let humanTotal = 0;
  let humanHit = 0;
  const missed = [];
  const falsePositives = [];

  for (const item of corpus) {
    const result = R.scoreComment(
      { message: item.text, uname: item.uname, isSub: false },
      { level }
    );
    if (item.expect === 'bot') {
      botTotal += 1;
      if (result.hit) botHit += 1;
      else missed.push(`    ${result.score} | ${item.uname} | ${item.text.slice(0, 60)}`);
    } else {
      humanTotal += 1;
      if (result.hit) {
        humanHit += 1;
        falsePositives.push(`    ${result.score} | ${item.uname} | ${item.text.slice(0, 50)}`);
      }
    }
  }

  if (level === 'balanced') balancedRecall = botHit;
  console.log(`[${level}] 机器人 ${botHit}/${botTotal} 命中；真人误伤 ${humanHit}/${humanTotal}`);
  if (level === 'balanced') {
    if (missed.length) {
      console.log('  漏掉的机器人：');
      missed.forEach((line) => console.log(line));
    }
    if (falsePositives.length) {
      console.log('  误伤的真人：');
      falsePositives.forEach((line) => console.log(line));
    }
  }
}

if (balancedRecall < 30) {
  console.error('\n平衡档机器人召回低于 30/34，请检查规则改动。');
  process.exitCode = 1;
}
