# 桃夭 · B站每日白嫖 & 经验（油猴脚本）

作者：[LHuiMeng](https://github.com/LHuiMeng) · 版本 v1.2.1

进 B 站自动把每日经验任务和能白嫖的东西做完，右下角一块小面板逐条报结果。

## 装

**方式一（推荐，能自动更新）**：装好 Tampermonkey 后直接打开：

```
https://raw.githubusercontent.com/LHuiMeng/bili-daily-userscript/main/bili-daily.user.js
```

Tampermonkey 会弹安装页。脚本头里写了 `@updateURL`，之后推新版你这边会自动提示更新。

**方式二**：Tampermonkey 面板 →「添加新脚本」→ 把 `bili-daily.user.js` 全文粘进去 → Ctrl+S。

装好打开 https://www.bilibili.com/ ，右下角出现「桃夭 · B站每日 v1.2.1」，2.5 秒后自己开跑。

> **排障前先看标题那行的版本号。** 拿旧版的输出判新版，会白忙一轮（已经踩过一次）。

## 它干什么

| 任务 | 接口 | 说明 |
| --- | --- | --- |
| 登录态 / 每日任务总览 | `GET /x/web-interface/nav`、`GET /x/member/web/exp/reward` | 显示等级、硬币、大会员，和今天哪些任务还没做 |
| 观看视频 +5 | `POST /x/click-interface/click/web/h5` → `POST /x/click-interface/web/heartbeat` ×2 | 必须三步：先报「进入视频页」，再报「开始播放」，5 秒后把进度推到接近片尾。**只发心跳不算数**（v1.0.0 真机验证过，`code:0` 但 `watch` 不变） |
| 分享视频 +5 | `POST /x/web-interface/share/add` | 发完复查 `exp/reward.share`，不轻信 `code:0` |
| 投币（每枚 +10，日上限 50） | `GET /x/web-interface/coin/today/exp`、`POST /x/web-interface/coin/add` | 先查今天已得多少投币经验，只补差额；投前查 `archive/coins` 确认没投过 |
| 大会员每日经验 +10 | `POST /x/vip/experience/add` | 需先完成观看 |
| 大会员每月权益 | `GET /x/vip/privilege/my`、`POST /x/vip/privilege/receive` | B 币券、会员购券等，只在「可领」时动手 |
| 漫画签到 | `POST manga.bilibili.com/twirp/activity.v1.Activity/ClockIn` | 每天一次 |
| 银瓜子换硬币 | `GET /xlive/revenue/v1/wallet/getStatus`、`POST /xlive/revenue/v1/wallet/silver2coin` | 先看今天还剩几次、银瓜子够不够 700（不够就跳过，不硬发） |
| 直播签到 | `GET /xlive/web-ucenter/v1/sign/DoSign` | **官方已下线**，脚本会显示「官方已下线」，留着只为某天复活 |
| 大会员积分签到 | `POST /pgc/activity/score/task/sign2` | Referer 必须是 `big.bilibili.com`。脚本自己挂隐藏 iframe 进去跑，**不用你切页面**；15 秒没回话就报「借道超时」 |

满额一天 65 经验（登录 5 + 观看 5 + 分享 5 + 投币 50）+ 大会员 10 经验。

## 需要特定子域的操作怎么自动做

`sign2` 只认 `big.bilibili.com` 的 Referer，而 fetch 改不了 Referer。脚本的做法是：在页面里挂一个隐藏 iframe 指向 `big.bilibili.com/mobile/bigPoint/task`，脚本会在 iframe 里被注入（所以本脚本没有 `@noframes`），那次请求的 Referer 天然就是对的；跑完用 `postMessage` 带 nonce 回传结果，父页面校验后拆掉 iframe。

实测依据：该域没有 `X-Frame-Options`、没有 CSP `frame-ancestors`，也没有 frame-busting（嵌入后父页面 URL 不被顶走）；**真实登录态下已跑通**，返回 `+5 积分 · 累计 1/7 天`。

iframe 里的脚本只做被指派的那一件事：不挂面板、不抢锁、不写每日标记。其它 iframe 一律直接 return，避免页面内多个 frame 重复跑全套任务。

## 怎么改

脚本开头 `CONFIG` 那段，改完保存刷新页面即可：

```js
coin: true,        // 不想花硬币就改 false
coinPerRun: 5,     // 单次最多投几枚（5 枚 = 满 50 经验）
keepCoins: 20,     // 硬币余额低于这个数就不投了
selectLike: false, // 投币时是否顺带点赞（会进你的点赞列表，默认关）
manga: true,       // 漫画签到
silver2coin: true, // 银瓜子换硬币
autoRun: true,     // 进页面自动跑
```

Tampermonkey 菜单里还有「立即重跑 B站每日」「清除『今天已跑』标记」。

## 几个刻意的设计

- **不碰密码**：全部走你浏览器里的登录态（`SESSDATA` / `bili_jct`），脚本自己读不到也存不了。
- **一天只跑一次**：跑完写本地标记，当天再进页面不会重复；多标签页有跨标签页锁，不会两边同时投币。
- **投币前查余额和已投**：`archive/coins` 确认这个稿件没投过，`keepCoins` 兜底，避免把硬币投干。
- **风控就收手**：分享遇 `-403`、投币遇非预期错误码直接停，不做无意义重试（越试越黑）。
- **面板即日志**：每条任务单独 try/catch，一条失败不影响其它；哪条不对，看面板那行返回码就够定位。

## 已知边界

- 直播宝箱、天选时刻抽奖、粉丝勋章任务没做——这些要真进直播间挂心跳、自动关注/发弹幕，风控和骚扰都太重，不做。
- 「绑定手机/邮箱」那 50/100 经验是一次性任务，接口没法代做。
- **观看任务目前不可靠**：只上报播放链路仍可能不被 B 站认可（v1.2.0 真机验过一次，`watch` 仍是 false）。下一步要么真开小窗播 30 秒，要么放弃这 5 经验。
- 「本次经验 +X」这个汇总不可靠——`nav` 里的 `current_exp` 有刷新延迟，以站内经验页为准。
- 若你登录态失效，借道 iframe 会被跳到 passport 登录页，15 秒后报「借道超时」——那是登录问题，不是脚本问题。

## 版本记录

- **v1.2.1** 作者改为 LHuiMeng；分享任务改为复查状态后再报成功；面板标题显示版本号
- **v1.2.0** 大会员积分签到改用隐藏 iframe 借道 `big.bilibili.com`，不再需要手动切页面；`exp/reward.coins` 修正为「投币经验 /50」
- **v1.1.0** 观看改为真实播放器三步链路；银瓜子加 700 门槛
- **v1.0.0** 首版

## License

MIT
