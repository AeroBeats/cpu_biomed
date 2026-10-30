-- 药大生医初试复习台 · 自建服务器数据库结构
-- 内容三表与 Qoder Sites 云端已应用的 schema v1 一致，仅把 app schema 换成 public。
-- app_users / user_progress 只存在于自建部署：账号与进度同步是自建服务独有的能力，
-- Qoder 站点那边由平台网关提供身份，不需要同样的表。
-- 由 docker-entrypoint-initdb.d 在数据卷首次初始化时自动执行；
-- 也可手工执行：psql "$DATABASE_URL" -f schema.sql

CREATE TABLE IF NOT EXISTS questions (
  id           text         NOT NULL,
  subject      text         NOT NULL,
  chapter      text         NOT NULL,
  qtype        text         NOT NULL,
  level        integer      NOT NULL,
  tags         jsonb        NOT NULL,
  stem         text         NOT NULL,
  opts         jsonb        NOT NULL,
  answer       jsonb        NOT NULL,
  explain_text text         NOT NULL,
  source       text,
  built_in     boolean      NOT NULL,
  sort_order   integer      NOT NULL,
  created_at   timestamptz  NOT NULL,
  updated_at   timestamptz  NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS questions_subject_idx ON questions USING btree (subject);
CREATE INDEX IF NOT EXISTS questions_chapter_idx ON questions USING btree (chapter);

CREATE TABLE IF NOT EXISTS syllabus_chapters (
  id         text         NOT NULL,
  subject    text         NOT NULL,
  name       text         NOT NULL,
  weight     integer      NOT NULL,
  points     jsonb        NOT NULL,
  sort_order integer      NOT NULL,
  built_in   boolean      NOT NULL,
  created_at timestamptz  NOT NULL,
  updated_at timestamptz  NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS syllabus_chapters_subject_idx ON syllabus_chapters USING btree (subject);

CREATE TABLE IF NOT EXISTS cards (
  id         text         NOT NULL,
  subject    text         NOT NULL,
  chapter    text         NOT NULL,
  front      text         NOT NULL,
  back       text         NOT NULL,
  sort_order integer      NOT NULL,
  built_in   boolean      NOT NULL,
  created_at timestamptz  NOT NULL,
  updated_at timestamptz  NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS cards_subject_idx ON cards USING btree (subject);

CREATE TABLE IF NOT EXISTS app_users (
  user_id      text        NOT NULL,
  username     text        NOT NULL,
  pass_hash    text        NOT NULL,
  role         text        NOT NULL,
  display_name text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id),
  CONSTRAINT app_users_username_key UNIQUE (username),
  CONSTRAINT app_users_role_check CHECK (role IN ('admin', 'user'))
);

CREATE TABLE IF NOT EXISTS user_progress (
  user_id    text        NOT NULL PRIMARY KEY REFERENCES app_users (user_id) ON DELETE CASCADE,
  data       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

/* 注册邀请码 · 一次性
   used_by 为空 = 还没用过。删账号时把它置 NULL 而不是级联删除：
   README 里「删掉账号让人重新注册」是常规操作，外键如果 RESTRICT 会让那条 DELETE 直接失败；
   留着 used_at 才能证明这个码确实被消费过，只是使用者已经不在了。 */
CREATE TABLE IF NOT EXISTS invite_codes (
  code       text        NOT NULL,
  note       text        NOT NULL DEFAULT '',
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_by    text        REFERENCES app_users (user_id) ON DELETE SET NULL,
  used_at    timestamptz,
  PRIMARY KEY (code)
);
