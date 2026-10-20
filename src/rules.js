/**
 * rules.js —— 「别看大肥鱼了！」的判定库（纯函数，无副作用）
 *
 * 一套代码三处用：
 *   1. 主世界（world: MAIN）——拦截评论接口时给每条评论打分
 *   2. 隔离世界（content script）——兜底扫描 DOM 时打分
 *   3. Node 单元测试（tests/rules.test.mjs）
 *
 * 暴露方式：浏览器里挂到 globalThis.BSH_RULES；Node 下 module.exports。
 * 依赖：无。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof root !== 'undefined' && root) root.BSH_RULES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.1.0';

  /** 三档阈值：分数 >= 阈值就判定为疑似机器人 */
  const THRESHOLDS = { conservative: 8, balanced: 6, aggressive: 4 };

  /** 账号名提示词：命中 +2 分，但单靠名字不隐藏（容易误伤） */
  const NAME_HINT_RE = /肥鱼|大肥鱼|小肥鱼|白饭|大白饭|白饭鱼|鲸鱼|鲸鱼娘|鲸鲸|小鲸|小鲸鱼|渔喵|海fish|fish|鱼|鲸|token|deepseek|深度求索|dsh|刷b站|bili-?scroll|机器人|学妹/i;

  /** AI 推荐语（来自 dsh-bili-scroll 的 prompts/duty.md：短、干净、推荐向） */
  const BOT_PHRASE_RE = /值得(?:一看|看|推荐)?|推荐(?:看看|一看)?|可以去看看|建议(?:看看|一看)|这期|这条视频|这视频|讲得(?:很)?(?:清楚|明白)|干货|看完|总结一下|一口气/;

  /** 「@某人 + 推荐」结构 */
  const RECOMMEND_RE = /@\S+[\s\S]{0,80}(?:值得|推荐|看看|这期|视频|讲)/;

  /** 顶层评论以 @昵称 开头（B 站 @ 后面可能带一个空格，如「@ 某某」） */
  const MENTION_START_RE = /^@\s?\S{1,24}[\s，,：:]/;

  /** 真人口语 / 互动痕迹 */
  const CASUAL_RE = /哈哈|笑死|草|啊啊|呜呜|233|狗头|doge|兄弟们|家人们/;

  /** 疑似 AI 人设口吻（DSH 刷B站插件常带主人设：主人/本鱼/人家/喵/🐟/咕噜…） */
  const PERSONA_RE = /主人|人家|本鱼|本鲸|本喵|咱家|鲸鱼娘|甩尾鳍|小本本|咕噜|诶嘿|唔[。！…~～]?|喵|🐟|🐳|ω|￣▽￣|妈妈[，,]/;

  /** 这批机器人爱用的插件圈术语（命中 ≥2 个不同词才加分，避免误伤普通讨论） */
  const TOPIC_RE = /原生工具|原生插件|原生接口|原生能力|插件|子\s?agent|子代理|提示词|上下文|token|skill|斜杠|explore|review|oil\s*ui|dsh|deepseek|1017|v4\.1|flash|落地页|侧边栏|查元素|截图|看动画|排版|审美|设计稿/gi;

  /** 「把 X 改成 Y」的改造句式（机器人高频；也覆盖省略「把」的「X 做成插件」） */
  const TRANSFORM_RE = /(?:把|将)?[^，。！？\n]{0,30}(?:做成|改成|封成|包成|收成|变成)[^，。！？\n]{0,20}(?:原生|工具|插件|能力)/;

  /** 评价/推荐口吻（比「值得」更宽） */
  const REVIEW_RE = /值钱|能打|稳了|够用|见长|涨了|成品|试水|装上|装完|装来|够看|最值|省下|省掉|省\s?token|省心|省事|省力|好装|装法/;

  /** 真人吐槽/提问里常见的转折词（机器人很少有负面转折） */
  const NEGATIVE_RE = /不过|但是|有点|卡住|bug|翻车|拉胯|一般|难用|失望/i;

  /** 链接、图片、BV 号（正常评论常见，机器人很少） */
  const LINK_RE = /https?:\/\/|BV[0-9A-Za-z]{10}|\[[^\]]{1,16}\]|【[^】]{1,16}】/;

  /** 提问口吻 */
  const QUESTION_RE = /[?？]|(?:吗|呢)[\s。.!！~～]*$/;

  /** 归一化：去零宽、压缩空白、trim */
  function normalize(value) {
    return String(value == null ? '' : value)
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function charLen(value) {
    return Array.from(normalize(value)).length;
  }

  function normalizeName(value) {
    return normalize(value).toLowerCase();
  }

  /** 名称黑名单：忽略大小写的「包含」匹配（用户手动添加，直接隐藏） */
  function matchesBlockedName(uname, nameBlocks) {
    const name = normalizeName(uname);
    if (!name || !Array.isArray(nameBlocks) || nameBlocks.length === 0) return false;
    return nameBlocks.some(function (item) {
      const key = normalizeName(typeof item === 'string' ? item : item && item.name);
      return !!key && name.indexOf(key) !== -1;
    });
  }

  /**
   * 给单条评论打分。
   * @param {{message?:string,text?:string,uname?:string,name?:string,isSub?:boolean}} comment
   * @param {{level?:'conservative'|'balanced'|'aggressive'}} [opts]
   * @returns {{score:number,reasons:string[],threshold:number,hit:boolean,strong:boolean,text:string,uname:string,len:number}}
   */
  function scoreComment(comment, opts) {
    const options = opts || {};
    const text = normalize(comment && (comment.message != null ? comment.message : comment.text));
    const uname = normalize(comment && (comment.uname != null ? comment.uname : comment.name));
    const isSub = !!(comment && comment.isSub);
    const level = options.level || 'balanced';
    const reasons = [];
    let score = 0;

    const nameHint = NAME_HINT_RE.test(uname);
    if (nameHint) {
      score += 2;
      reasons.push('账号名含提示词');
    }

    const atCount = (text.match(/@/g) || []).length;
    const hasMention = atCount > 0;
    const mentionStart = MENTION_START_RE.test(text);
    if (!isSub) {
      if (mentionStart) {
        score += 3;
        reasons.push('顶层评论以@昵称开头');
      } else if (hasMention) {
        score += 1;
        reasons.push('正文含@');
      }
      if (atCount >= 2) {
        score += 2;
        reasons.push('一次@多个账号');
      }
    }
    // 楼中楼里的 @ 是正常社交，不加分（后面还会 -3）

    const phrase = BOT_PHRASE_RE.test(text);
    if (phrase) {
      score += 2;
      reasons.push('含AI推荐语');
    }

    const persona = PERSONA_RE.test(text);
    if (persona) {
      score += 2;
      reasons.push('疑似AI人设口吻');
    }

    const topicSet = new Set(
      (text.match(TOPIC_RE) || []).map(function (term) {
        return term.toLowerCase();
      })
    );
    if (topicSet.size >= 5) {
      score += 3;
      reasons.push('插件术语密集');
    } else if (topicSet.size >= 3) {
      score += 2;
      reasons.push('插件术语密集');
    } else if (topicSet.size === 2) {
      score += 1;
      reasons.push('出现插件术语');
    }

    const transform = TRANSFORM_RE.test(text);
    if (transform) {
      score += 2;
      reasons.push('「把X改成Y」句式');
    }

    if (REVIEW_RE.test(text)) {
      score += 1;
      reasons.push('评价/推荐口吻');
    }

    const recommend = !isSub && RECOMMEND_RE.test(text);
    if (recommend) {
      score += 2;
      reasons.push('符合@+推荐结构');
    }

    const len = charLen(text);
    if (len >= 20 && len <= 200) {
      score += 1;
      reasons.push('长度符合机器人模板');
    }
    if (len > 300) {
      score -= 2;
      reasons.push('超长评论');
    }

    if (len > 0 && !CASUAL_RE.test(text) && !/[?？!！~～]/.test(text)) {
      score += 1;
      reasons.push('无口语/互动标点');
    }

    if (isSub) {
      score -= 3;
      reasons.push('楼中楼回复');
    }
    if (LINK_RE.test(text)) {
      score -= 2;
      reasons.push('含链接/图片/BV');
    }
    const qCount = (text.match(/[?？]/g) || []).length;
    if (qCount) {
      // 机器人发的是「推荐」，不是提问；连续追问更像真人
      score -= 2;
      if (qCount >= 2) score -= 3;
      reasons.push('像真人提问');
    }
    if (NEGATIVE_RE.test(text)) {
      score -= 1;
      reasons.push('带真人吐槽口吻');
    }

    const threshold = THRESHOLDS[level] || THRESHOLDS.balanced;
    const strong =
      (!isSub && mentionStart) ||
      (phrase && hasMention) ||
      (nameHint && (phrase || hasMention || transform)) ||
      persona;

    return {
      score: score,
      reasons: reasons,
      threshold: threshold,
      hit: score >= threshold,
      strong: !!strong,
      text: text,
      uname: uname,
      len: len
    };
  }

  /** 字符二元组（用于同模板聚类；中文按字符切） */
  function bigrams(value) {
    const chars = Array.from(normalize(value).replace(/@\S+/g, '@'));
    const set = new Set();
    for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
    return set;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach(function (g) {
      if (b.has(g)) inter++;
    });
    return inter / (a.size + b.size - inter);
  }

  /**
   * 同页聚类：这条评论是否和至少 minCount 个「其它账号」的评论同模板。
   * @param {Array<{uid:string|number,text:string}>} items
   * @param {string} text 当前评论文本
   * @param {string|number} uid 当前评论作者
   * @param {number} [minCount=2] 需要多少个其它账号
   * @returns {boolean}
   */
  function hasCluster(items, text, uid, minCount) {
    const need = minCount == null ? 2 : minCount;
    if (!Array.isArray(items) || items.length < need) return false;
    const mine = bigrams(text);
    if (mine.size < 6) return false;
    const uids = new Set();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (String(item.uid) === String(uid)) continue;
      if (jaccard(mine, bigrams(item.text)) >= 0.35) uids.add(String(item.uid));
      if (uids.size >= need) return true;
    }
    return false;
  }

  return {
    VERSION: VERSION,
    THRESHOLDS: THRESHOLDS,
    NAME_HINT_RE: NAME_HINT_RE,
    BOT_PHRASE_RE: BOT_PHRASE_RE,
    PERSONA_RE: PERSONA_RE,
    RECOMMEND_RE: RECOMMEND_RE,
    MENTION_START_RE: MENTION_START_RE,
    normalize: normalize,
    charLen: charLen,
    matchesBlockedName: matchesBlockedName,
    scoreComment: scoreComment,
    bigrams: bigrams,
    jaccard: jaccard,
    hasCluster: hasCluster
  };
});
