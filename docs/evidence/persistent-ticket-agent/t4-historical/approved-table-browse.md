# 已授权图片表的首次浏览

伊之密实际续接后保存四个文件的修复并报告 17 项测试通过，但随后要求用户先提供机台号才能从已经批准的整张图片表检索。原接口强制非空 contains 查询，因此 Agent 无法先浏览获批来源了解真实值。

queryTableImages 现在允许空字符串表示分页浏览，只去掉机台搜索条件。原 source 别名授权、表、view、字段清单、图片非空过滤、每页 20 条、游标校验、每轮请求限制、图片选取和下载时的再次授权均保留。空白乱码查询仍拒绝。不增加项目范围，不改变 Scope 或 Runtime Pin，也不授予直接飞书网络/凭据。

红：相同浏览调用被旧代码以查询文本无效拒绝。绿：新用例验证固定 view/fields、无多余字段外泄、空查询分页、普通搜索和无效游标；原 C01 真实 Bubblewrap 的查询、图片缓存、撤权、定向话题回执回归通过。

命令：node scripts/test-task-graph-postgres.mjs project-capabilities-browse project-capabilities-c01。新增用例已注册到现有必跑集合。客户端继续使用既有 query 命令，查询参数传空字符串；没有新增恢复状态或 Prompt 框架。
