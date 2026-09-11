# Agent Note: 宠物设置卡片的注册表加载跟随总开关

Status: implemented

## Problem

当宠物总开关关闭时（`settings.yaml` 中的 `pet: { enabled: false }`），浏览器依然会发起 `GET /api/pet/pets` 与 `GET /api/pet/diagnostics`，服务端返回 404，控制台持续输出 `Failed to load resource: the server responded with a status of 404 (Not Found)`。

宿主半区只在开关打开时注册 `/api/pet/*` 路由：`packages/dsh-pet/src/index.ts` 在 `enabled` 为 false 时通过 `syncRoutes()` 撤销路由，而 `packages/host/webserver` 对没有任何路由认领的路径一律返回 404。因此 `enabled: false` 的含义是「这些端点不存在」，而不是「这些端点拒绝请求」。

浏览器半区只在一个地方读取了这个结论。`packages/dsh-pet/src/client/index.ts` 用 `enabled()` 约束了悬浮精灵的轮询循环，却无条件构造了 `PetSettingsCardController`，而该控制器的构造函数会挂一个延时定时器，无论开关状态都去拉取注册表。`loadPets` 失败后还会间隔 3 秒重试 3 次，于是一个被关闭的宠物产生的是一串周期性 404，而不是一次失败请求。

这个不对称就是缺陷本身：一个开关，两个消费者，只有其中一个读了这个开关。

## Decision

卡片的注册表加载跟随总开关，与精灵读取同一个判定函数。

`packages/dsh-pet/src/client/PetSettingsCard.tsx` 中的 `petEnabled(snapshot)` 现在是唯一的开关判定。`packages/dsh-pet/src/client/index.ts` 改为调用它来驱动精灵的轮询循环，不再自带一份副本，因此两个消费者不会再各自漂移。`enabled` 未设置表示开启（schema 默认值）；`loading` 状态的命名空间按关闭处理，使首次加载先等判定结果，而不是朝着可能尚不存在的路由发请求；`unavailable` 状态按开启处理，因为此时没有开关可读。该开关作为插件总开关的含义由[远程在线状态隐藏与恢复宠物](2026-08-30-remote-presence-pet-visibility.zh.md)确立；本记录扩展的是哪些消费者遵守它。

`PetSettingsCardController` 订阅自己的 settings scope，并把所有加载收敛到 `syncLoad()`，由它在发请求前读取开关。这一形态的后果：

- 关闭的宠物完全不发请求，因此不会产生 404。
- 打开开关会加载注册表，因为 settings 订阅会重新触发 `syncLoad()`。
- 失败挂起的重试定时器在开关关闭时被取消，重试预算在开关重新打开时重置：期间端点已被撤销，之前的失败并不能说明现在存在的路由。
- 进行中守卫（`petsLoading`、`diagnosticsLoading`、`retryScheduled`）保证加载途中落地的 settings 通知不会启动第二次加载。
- 控制器持有自己的 scope 订阅（`disposeScope`）并在 `dispose()` 中释放；此前只释放了表单自身的订阅。

宠物关闭时设置卡片本身保持注册。它正是用户重新打开宠物的入口，把卡片随宠物一起隐藏会让用户无处恢复。

## Testing

`packages/dsh-pet/tests/pet-settings-enabled.spec.tsx` 覆盖开关契约：关闭时不发请求（跨越整个重试窗口）、开关打开后加载、开关关闭时丢弃挂起的重试、未设置开关时加载。

既有测试的假 scope 不带 `status` 字段，而新判定函数会读取它；`pet-diagnostics.spec.tsx` 与 `pet-settings-dispose.spec.tsx` 现在返回 `status: 'ready'`，与真实 scope 一致。

`pnpm --filter @linxin666/dsh-pet typecheck` 与该包测试套件（497 个用例）通过。

## Alternatives considered

**让宿主路由在宠物关闭时保持注册。** 这能通过让端点始终存在来消除 404。否决理由：撤销路由是该开关已声明的语义——`packages/dsh-pet/src/routes.ts` 与宿主 `apply` 函数都写明关闭宠物会让其 API 消失，配对围栏与资源路由也共享同一生命周期。为了省掉一个客户端请求而扩大暴露面，是把契约反过来做。

**把卡片的加载改为设置页首次渲染时才触发（惰性加载）。** 这同样能消除空闲请求，而且还能额外避免为从不打开宠物设置页的用户拉取。它未被采纳为本轮修法，是因为它本身并不跟随开关：宠物关闭时打开该页仍会发请求。它仍是一项可独立推进的合理改进。

**保留无条件控制器，只在控制台抑制 404。** 这是掩盖症状：浏览器仍在调用宿主已撤销的路由，而且会一并掩盖日后真正缺失的路由。否决理由：缺陷是请求本身，不是它的日志。
