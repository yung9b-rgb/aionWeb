-- AionShop schema (generated from server/shopdb.ts SCHEMA; the admin runs these idempotent batches on every start)
-- CREATE DATABASE [AionShop] COLLATE Chinese_PRC_CI_AS;
USE [AionShop];
GO
IF OBJECT_ID('dbo.schema_meta') IS NULL CREATE TABLE dbo.schema_meta (
  k nvarchar(64) NOT NULL CONSTRAINT PK_schema_meta PRIMARY KEY,
  v nvarchar(400) NOT NULL,
  updated_at datetime2(3) NOT NULL CONSTRAINT DF_schema_meta_updated DEFAULT SYSUTCDATETIME())
GO
IF OBJECT_ID('dbo.account_point') IS NULL CREATE TABLE dbo.account_point (
  account_id int NOT NULL CONSTRAINT PK_account_point PRIMARY KEY,
  account_name nvarchar(32) NULL,
  balance bigint NOT NULL CONSTRAINT DF_account_point_balance DEFAULT 0 CONSTRAINT CK_account_point_balance CHECK (balance >= 0),
  updated_at datetime2(3) NOT NULL CONSTRAINT DF_account_point_updated DEFAULT SYSUTCDATETIME())
GO
IF OBJECT_ID('dbo.point_ledger') IS NULL CREATE TABLE dbo.point_ledger (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_point_ledger PRIMARY KEY,
  account_id int NOT NULL,
  delta bigint NOT NULL,
  balance_after bigint NOT NULL,
  kind varchar(16) NOT NULL CONSTRAINT CK_point_ledger_kind CHECK (kind IN ('topup','deduct','purchase','refund','adjust')),
  order_id bigint NULL,
  operator nvarchar(32) NOT NULL,
  reason nvarchar(200) NOT NULL,
  server_id int NULL,
  created_at datetime2(3) NOT NULL CONSTRAINT DF_point_ledger_created DEFAULT SYSUTCDATETIME())
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_point_ledger_account')
  CREATE INDEX IX_point_ledger_account ON dbo.point_ledger (account_id, id DESC)
GO
IF OBJECT_ID('dbo.shop_category') IS NULL CREATE TABLE dbo.shop_category (
  category_id int NOT NULL CONSTRAINT PK_shop_category PRIMARY KEY,
  parent_id int NOT NULL CONSTRAINT DF_shop_category_parent DEFAULT 0,
  name nvarchar(50) NOT NULL,
  display_order smallint NOT NULL CONSTRAINT DF_shop_category_order DEFAULT 0,
  enabled bit NOT NULL CONSTRAINT DF_shop_category_enabled DEFAULT 1,
  updated_at datetime2(3) NOT NULL CONSTRAINT DF_shop_category_updated DEFAULT SYSUTCDATETIME())
GO
IF OBJECT_ID('dbo.shop_goods') IS NULL CREATE TABLE dbo.shop_goods (
  goods_id int NOT NULL CONSTRAINT PK_shop_goods PRIMARY KEY,
  goods_name nvarchar(50) NOT NULL,
  item_name_id int NOT NULL,
  item_amount int NOT NULL CONSTRAINT DF_shop_goods_amount DEFAULT 1 CONSTRAINT CK_shop_goods_amount CHECK (item_amount > 0),
  item_duration_sec int NOT NULL CONSTRAINT DF_shop_goods_duration DEFAULT 0,
  sale_price int NOT NULL CONSTRAINT CK_shop_goods_price CHECK (sale_price >= 0),
  price_category int NOT NULL CONSTRAINT DF_shop_goods_pcat DEFAULT 1,
  price_id int NOT NULL CONSTRAINT DF_shop_goods_pid DEFAULT 1,
  sale_quantity int NOT NULL CONSTRAINT DF_shop_goods_qty DEFAULT 9999,
  sale_status smallint NOT NULL CONSTRAINT DF_shop_goods_status DEFAULT 1,
  item_type_code smallint NOT NULL CONSTRAINT DF_shop_goods_type DEFAULT 0,
  icon_key bigint NOT NULL CONSTRAINT DF_shop_goods_icon DEFAULT 0,
  icon_bitset int NOT NULL CONSTRAINT DF_shop_goods_iconbits DEFAULT 0,
  description nvarchar(200) NOT NULL CONSTRAINT DF_shop_goods_desc DEFAULT N'',
  avail_start bigint NOT NULL CONSTRAINT DF_shop_goods_start DEFAULT 0,
  avail_end bigint NOT NULL CONSTRAINT DF_shop_goods_end DEFAULT 0,
  enabled bit NOT NULL CONSTRAINT DF_shop_goods_enabled DEFAULT 1,
  updated_at datetime2(3) NOT NULL CONSTRAINT DF_shop_goods_updated DEFAULT SYSUTCDATETIME())
GO
IF OBJECT_ID('dbo.shop_goods_category') IS NULL CREATE TABLE dbo.shop_goods_category (
  goods_id int NOT NULL CONSTRAINT FK_sgc_goods REFERENCES dbo.shop_goods (goods_id),
  category_id int NOT NULL CONSTRAINT FK_sgc_category REFERENCES dbo.shop_category (category_id),
  display_order smallint NOT NULL CONSTRAINT DF_sgc_order DEFAULT 0,
  CONSTRAINT PK_shop_goods_category PRIMARY KEY (goods_id, category_id))
GO
IF OBJECT_ID('dbo.shop_ranking') IS NULL CREATE TABLE dbo.shop_ranking (
  ranking_type smallint NOT NULL CONSTRAINT DF_shop_ranking_type DEFAULT 1,
  position int NOT NULL,
  goods_id int NOT NULL CONSTRAINT FK_shop_ranking_goods REFERENCES dbo.shop_goods (goods_id),
  CONSTRAINT PK_shop_ranking PRIMARY KEY (ranking_type, position))
GO
IF OBJECT_ID('dbo.shop_promotion') IS NULL CREATE TABLE dbo.shop_promotion (
  promotion_id int NOT NULL CONSTRAINT PK_shop_promotion PRIMARY KEY,
  goods_id int NOT NULL CONSTRAINT FK_shop_promotion_goods REFERENCES dbo.shop_goods (goods_id),
  avail_start bigint NOT NULL CONSTRAINT DF_shop_promotion_start DEFAULT 0,
  avail_end bigint NOT NULL CONSTRAINT DF_shop_promotion_end DEFAULT 0)
GO
IF OBJECT_ID('dbo.seq_order') IS NULL CREATE SEQUENCE dbo.seq_order AS bigint START WITH 1000001 INCREMENT BY 1
GO
IF OBJECT_ID('dbo.shop_order') IS NULL CREATE TABLE dbo.shop_order (
  order_id bigint NOT NULL CONSTRAINT PK_shop_order PRIMARY KEY,
  request_key varchar(64) NULL,
  server_id int NULL,
  status varchar(12) NOT NULL CONSTRAINT CK_shop_order_status CHECK (status IN ('paid','delivered','refunded')),
  buyer_account_id int NOT NULL,
  buyer_char_id int NOT NULL,
  buyer_char_name nvarchar(32) NOT NULL,
  recipient_char_id int NULL,
  recipient_name nvarchar(32) NULL,
  recipient_checked bit NOT NULL CONSTRAINT DF_shop_order_rchecked DEFAULT 0,
  goods_id int NULL,
  goods_name nvarchar(50) NOT NULL,
  item_name_id int NOT NULL,
  item_amount int NOT NULL,
  item_duration_sec int NOT NULL CONSTRAINT DF_shop_order_duration DEFAULT 0,
  unit_count int NOT NULL CONSTRAINT DF_shop_order_units DEFAULT 1,
  price bigint NOT NULL,
  price_category int NOT NULL CONSTRAINT DF_shop_order_pcat DEFAULT 1,
  price_id int NOT NULL CONSTRAINT DF_shop_order_pid DEFAULT 1,
  redelivered int NOT NULL CONSTRAINT DF_shop_order_redelivered DEFAULT 0,
  created_at datetime2(3) NOT NULL CONSTRAINT DF_shop_order_created DEFAULT SYSUTCDATETIME(),
  delivered_at datetime2(3) NULL)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_shop_order_request')
  CREATE UNIQUE INDEX UX_shop_order_request ON dbo.shop_order (request_key) WHERE request_key IS NOT NULL
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_shop_order_status')
  CREATE INDEX IX_shop_order_status ON dbo.shop_order (status, order_id)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_shop_order_buyer')
  CREATE INDEX IX_shop_order_buyer ON dbo.shop_order (buyer_account_id, order_id DESC)
GO
IF OBJECT_ID('dbo.admin_log') IS NULL CREATE TABLE dbo.admin_log (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_admin_log PRIMARY KEY,
  created_at datetime2(3) NOT NULL CONSTRAINT DF_admin_log_created DEFAULT SYSUTCDATETIME(),
  action varchar(32) NOT NULL,
  target nvarchar(100) NULL,
  detail nvarchar(max) NULL,
  ok bit NOT NULL CONSTRAINT DF_admin_log_ok DEFAULT 1,
  message nvarchar(400) NULL,
  remote_addr varchar(64) NULL)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_admin_log_action')
  CREATE INDEX IX_admin_log_action ON dbo.admin_log (action, id DESC)
GO
