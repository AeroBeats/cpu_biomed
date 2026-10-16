-- 药大生医初试复习台 · 自建服务器数据库结构
-- 与 Qoder Sites 云端已应用的 schema v1 完全一致，仅把 app schema 换成 public。
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

CREATE TABLE IF NOT EXISTS site_settings (
  id         text         NOT NULL,
  owner_id   text         NOT NULL,
  updated_at timestamptz  NOT NULL,
  PRIMARY KEY (id)
);
