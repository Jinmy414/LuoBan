# 罗瓣

动画作品发现社区。首页支持滑动选片、随机高分推荐、条件筛选、搜索和分批浏览。账号、头像、投稿与审核结果保存在服务端 SQLite。新投稿和已发布作品的修改都要经过审核。管理员可以修改稿件后发布，或填写原因退回。审核通过的作品可跨设备浏览。最爱、展示评论、评分和点赞仍保存在当前浏览器。

注册依次填写邮箱、输入六位验证码、设置用户名和密码。验证码有效期为 10 分钟，60 秒后可以重发。验证成功后有 15 分钟完成注册。之后可用用户名或邮箱加密码登录。个人主页可以修改用户名和密码，修改密码会撤销旧会话。

Excel 名单上的 11 个单字名已保留，历史评论和评分继续按原名展示。超级管理员可为每个单字名生成一枚七天有效的认领码，私下交给本人。成员从登录弹窗选择「老成员首次登录」，凭认领码验证自己的邮箱并设置密码。重新发码会使旧码失效，已绑定的账号无法再次认领。站点所有者可在私有配置中设置已核实的账号 ID 为 `SUPER_ADMIN_ID`。超级管理员在管理后台授予或收回普通管理员权限。未配置超级管理员时，可在后端设置 `ADMIN_EMAIL` 为自己控制的邮箱，完成正常注册和验证后即可进入管理后台。

## PythonAnywhere 免费部署

1. 在 Beginner 账户的 Bash 控制台把本分支克隆到 `~/luoban`。使用本账号支持的 Python 版本，以下以 3.13 为例。
2. 在项目目录运行以下命令。将示例域名换成 Web 页面显示的实际网址。

```bash
python3.13 -m venv ~/.virtualenvs/luoban
~/.virtualenvs/luoban/bin/pip install -r requirements.txt
python3.13 -m server.host_config --origin https://YOURNAME.pythonanywhere.com --mail
```

发件地址须在 Brevo 内完成验证。密钥在控制台以隐藏输入方式填写，保存到主目录下的私有配置文件。去掉 `--mail` 可以先发布作品库，之后补充邮件配置并重新加载网站。

3. 在 Web 页选 Add a new web app、Manual configuration 和同一 Python 版本。把 Virtualenv 设为 `/home/YOURNAME/.virtualenvs/luoban`。将该站点新生成的 WSGI 模板替换为 `server/pythonanywhere_wsgi.py` 的内容。
4. 启用 Force HTTPS 并 Reload。可把静态路径 `/assets/` 指向 `/home/YOURNAME/luoban/assets/`。打开网站，如果已启用入口验证，先通过验证。随后可用自己能收信的邮箱完成一次注册。
5. 免费站点每月需在 Web 页续期。备份账号数据时使用 SQLite 的在线备份工具，数据库位于 `instance/accounts.sqlite3`。

[PythonAnywhere 免费档](https://help.pythonanywhere.com/pages/FreeAccountsFeatures/) · [Flask 部署说明](https://help.pythonanywhere.com/pages/Flask/) · [Brevo 免费档](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans)

## 本地运行与其他主机

安装 Python 3.12+，在虚拟环境中执行 `pip install -r requirements.txt`。启动前设置以下环境变量。

| 变量 | 用途 |
| --- | --- |
| PUBLIC_ORIGIN | 完整网站源地址。默认 http://localhost:8000，公网使用 HTTPS。前后端部署在同一源。 |
| AUTH_SECRET | 服务端随机密钥，至少 32 字符。生成一次并长期保存在主机端。 |
| DATABASE | SQLite 文件路径。默认 instance/accounts.sqlite3，使用持久存储。 |
| SMTP_FROM | 服务商验证过的发件地址。 |
| BREVO_API_KEY | 使用 Brevo HTTPS 发信时配置。 |
| SMTP_HOST、SMTP_PORT、SMTP_SECURITY | 使用 SMTP 发信时配置。默认 587 和 starttls，也支持 ssl。 |
| SMTP_USER、SMTP_PASSWORD | SMTP 服务要求的用户名和授权码。 |
| SUPER_ADMIN_ID | 超级管理员的已验证账号 ID。 |
| ADMIN_EMAIL | 可选。仅将管理员身份赋予这个已验证的邮箱。 |

```bash
gunicorn --bind 127.0.0.1:8000 'server.app:create_app()'
python -m unittest discover -s tests
```

Docker 镜像将网站与账号服务一起运行。把仅主机可读的配置放在 .env 中，并为账号库挂载持久卷。在公网为服务配置 HTTPS 反向代理。

```bash
docker build -t luoban .
docker run --env-file .env -v luoban-accounts:/app/instance -p 127.0.0.1:8000:8000 luoban
```

GitHub Pages 和普通静态服务器支持浏览作品。邮箱收信、验证、密码登录、账号管理需要上面的服务端。网站在发送失败时会提示重试，验证码只发往邮箱。

动画名称、台词和导入评分来自原有资料。封面沿用项目内的本地图片。

投稿时可以附上官方作品页供管理员核对。历史平台资料部分来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data)，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用。

在「发现 → 罗瓣成员」可按名字找人，点击作品评论的署名或投稿的创建者也能进入公开主页。公开主页展示该成员选定的最爱、展示评论和审核发布的作品。原名单成员也可以通过历史署名访问。观看记录、草稿和审核意见只在自己的账号或已有权限的审核页面显示。

作品短评旁显示评论者给该作品的分数。登录后可以回复短评。收到回复或自己的已发布作品收到评论时，「发现」右下方会叠放未读提醒。打开一条会保存该条的已读状态。

## 站内分集播放

在已发布作品详情点「导入分集」。管理员选择片源后，可点「打开这部作品的片源目录」在新标签页读取 Apple CMS 搜索结果。复制完整 JSON 或保存为文件，在罗瓣粘贴或读取后点「解析分集」。核对片名、季度、线路及集数，再点「保存分集」。也支持每行一条「集名$HTTPS 的 .m3u8 地址」。同一部作品可分别保存多个片源，更新前会显示原线路的名称与集数。

哔哩哔哩和 YouTube 线路支持逐行导入各平台的嵌入播放器地址。详情页只显示当前作品、当前集有地址的线路。点击封面开始播放，HLS 线路加载失败时会尝试同一集的其他线路。平台的地区限制由播放平台决定。

浏览器直接向片源请求视频。罗瓣主机保存分集目录和账号观看记录。HLS 可续看到上次播放的时间，第三方嵌入播放器可续到上次打开的集。HLS 优先使用随项目分发的 [hls.js](https://github.com/video-dev/hls.js)，支持原生 HLS 的设备也可使用系统播放器。升级时会更新随版本发布的线路，并保留管理员手动修改和删除的记录。

### Cloudflare 免费服务

可在当前 PythonAnywhere 主机独立启用 Turnstile 和 Workers AI。Turnstile 小组件选择 Managed，并添加实际的网站主机名。Workers AI 使用免费计划和仅限目标账号的 Workers AI 推理令牌。

在主机的项目目录运行以下命令，按提示在终端输入小组件的 Site Key、Secret Key、Cloudflare Account ID 和 API Token。两个开关也可分别使用。配置会保存在现有私有设置文件中，完成后在 Web 页重载应用。

```sh
python -m server.host_config --origin https://jinmengyao.pythonanywhere.com --turnstile --workers-ai
```

启用 Turnstile 后，首次打开网站会先看到入口验证页。服务端核验域名和操作后签发浏览器会话 Cookie，最长有效 12 小时。验证成功后回到原访问地址，登录、发送注册邮件和动漫推荐共用本次通行状态。启用 Workers AI 后，动漫推荐优先使用 Llama 3.3 70B，额度用完或模型暂时不可用时会尝试 AI Horde Qwen。
