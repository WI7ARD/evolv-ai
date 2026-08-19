// Every table in a profile database, as an ordered, recorded migration list.
//
// This used to be split between one large bootstrap block here and four
// service constructors, so which tables a profile had depended on which
// services happened to initialize. Owning the schema in one place means a
// profile is always complete the moment it opens, and the ledger in
// schema_migrations records exactly what was applied.
//
// Rules for adding a migration:
//   - Append with the next version; never renumber or edit an applied one.
//   - Keep it idempotent (IF NOT EXISTS, or guard the change), because
//     databases that predate the ledger replay migrations above their
//     recorded version.
//   - The runner wraps each migration in a transaction and records its
//     version, name, and checksum.

// Version 10 matches the schema version that shipped before the ledger
// existed, so installations already carrying that row skip it rather than
// replaying the baseline.
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_deleted ON conversations(deleted_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT NOT NULL DEFAULT '',
  model TEXT,
  mode TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  tool_name TEXT,
  tool_call_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  rating TEXT NOT NULL CHECK(rating IN ('up','down')),
  note TEXT NOT NULL DEFAULT '',
  user_message TEXT NOT NULL DEFAULT '',
  assistant_message TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  version_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  tests_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  evaluator_model TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  domain TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_status TEXT NOT NULL DEFAULT 'lexical',
  source TEXT NOT NULL DEFAULT 'user-approved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_domain ON knowledge(domain);
CREATE TABLE IF NOT EXISTS architecture_proposals (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  changes_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  tests_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposal-only',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_config (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  risk TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_runs_created ON tool_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_receipts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_credentials (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  scrypt_n INTEGER NOT NULL,
  scrypt_r INTEGER NOT NULL,
  scrypt_p INTEGER NOT NULL,
  key_length INTEGER NOT NULL,
  recovery_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('project','task','decision','preference','note')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed','active','resolved','archived')),
  source TEXT NOT NULL DEFAULT 'user',
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  embedding BLOB,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_status TEXT NOT NULL DEFAULT 'lexical',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_status ON memory_nodes(status, type);
CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'relates-to',
  created_at TEXT NOT NULL,
  UNIQUE(from_id, to_id, relation)
);
CREATE TABLE IF NOT EXISTS tool_macros (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','rejected')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider_id TEXT PRIMARY KEY,
  encrypted_secret TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'configured',
  status_message TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  tested_at TEXT
);
CREATE TABLE IF NOT EXISTS model_preferences (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  enabled_auto INTEGER NOT NULL DEFAULT 1,
  quality INTEGER NOT NULL DEFAULT 3 CHECK(quality BETWEEN 1 AND 5),
  speed INTEGER NOT NULL DEFAULT 3 CHECK(speed BETWEEN 1 AND 5),
  cost INTEGER NOT NULL DEFAULT 2 CHECK(cost BETWEEN 0 AND 5),
  privacy INTEGER NOT NULL DEFAULT 3 CHECK(privacy BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS routing_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  task_json TEXT NOT NULL DEFAULT '{}',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  considered_json TEXT NOT NULL DEFAULT '[]',
  score REAL NOT NULL DEFAULT 0,
  cloud INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'selected',
  outcome TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_routing_events_created ON routing_events(created_at DESC);
CREATE TABLE IF NOT EXISTS evaluation_cases (
  id TEXT PRIMARY KEY,
  feedback_id TEXT UNIQUE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  input TEXT NOT NULL,
  expected_qualities TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  proposal_id TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS evaluation_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  critical_regression INTEGER NOT NULL DEFAULT 0,
  explanation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK(action IN ('create','update','merge','retire')),
  target_id TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('project','task','decision','preference','note')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  links_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status, created_at DESC);
CREATE TABLE IF NOT EXISTS intelligence_upgrades (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('prompt','routing')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','rolled-back')),
  payload_json TEXT NOT NULL,
  previous_json TEXT NOT NULL DEFAULT '{}',
  evaluation_run_id TEXT REFERENCES evaluation_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','planning','waiting_for_approval','executing','observing','evaluating','revising','paused','completed','failed','cancelled')),
  executor TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '{}',
  resume_state TEXT NOT NULL DEFAULT 'executing',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_active_conversation ON agent_runs(conversation_id)
  WHERE state IN ('idle','planning','waiting_for_approval','executing','observing','evaluating','revising','paused');
CREATE TABLE IF NOT EXISTS run_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','superseded','completed','cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(run_id, revision)
);
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES run_plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'chat',
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(plan_id, position)
);
CREATE INDEX IF NOT EXISTS idx_run_steps_runnable ON run_steps(run_id, state, position);
CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_run_events_sequence ON run_events(run_id, sequence);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  event_sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(run_id, event_sequence)
);
CREATE TABLE IF NOT EXISTS run_budgets (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  max_steps INTEGER NOT NULL,
  max_runtime_ms INTEGER NOT NULL,
  max_tool_calls INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  max_cost_units REAL NOT NULL,
  used_steps INTEGER NOT NULL DEFAULT 0,
  used_tool_calls INTEGER NOT NULL DEFAULT 0,
  used_retries INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_cost_units REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('read','network-read','approval-write','sensitive-write','command','destructive')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','failed','cancelled')),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  tool_run_id TEXT REFERENCES tool_runs(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  executed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_tool_run ON approval_requests(tool_run_id) WHERE tool_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_resource ON approval_requests(resource_type, resource_id);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_one_default ON projects(is_default) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS project_grants (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_grants_root ON project_grants(canonical_hash);
CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in-progress','blocked','done','archived')),
  priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS project_memory (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('working','project','long-term','strategy','failure')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,memory_id)
);
CREATE TABLE IF NOT EXISTS project_conversations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,conversation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_conversation_owner ON project_conversations(conversation_id);
CREATE TABLE IF NOT EXISTS project_runs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,run_id)
);
CREATE TABLE IF NOT EXISTS project_files (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY(project_id,relative_path)
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id,relative_path);
CREATE TABLE IF NOT EXISTS project_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_name TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(project_id,sha256)
);
CREATE INDEX IF NOT EXISTS idx_project_artifacts_project ON project_artifacts(project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS project_knowledge_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES project_artifacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('indexed','metadata-only','failed','deleted')),
  source_path TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_sources_project ON project_knowledge_sources(project_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS project_knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  locator TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id,position)
);
CREATE INDEX IF NOT EXISTS idx_project_chunks_source ON project_knowledge_chunks(source_id,position);
CREATE TABLE IF NOT EXISTS run_evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('provisional','rated','failed')),
  metrics_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  critical_regression INTEGER NOT NULL DEFAULT 0,
  feedback_rating TEXT CHECK(feedback_rating IN ('up','down') OR feedback_rating IS NULL),
  correction TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_evaluations_created ON run_evaluations(created_at DESC);
CREATE TABLE IF NOT EXISTS failure_patterns (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','candidate-created','resolved','dismissed')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failure_patterns_open ON failure_patterns(status,occurrences DESC,last_seen_at DESC);
CREATE TABLE IF NOT EXISTS benchmark_cases (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS strategy_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('prompt-guidance')),
  status TEXT NOT NULL CHECK(status IN ('active','candidate','rejected','superseded','rolled-back')),
  instruction TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES strategy_versions(id) ON DELETE SET NULL,
  failure_pattern_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_one_active ON strategy_versions(status) WHERE status='active';
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  baseline_strategy_id TEXT REFERENCES strategy_versions(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed','cancelled')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  estimated_cost_units REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS benchmark_results (
  id TEXT PRIMARY KEY,
  benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES benchmark_cases(id) ON DELETE CASCADE,
  baseline_output TEXT NOT NULL DEFAULT '',
  candidate_output TEXT NOT NULL DEFAULT '',
  baseline_metrics_json TEXT NOT NULL DEFAULT '{}',
  candidate_metrics_json TEXT NOT NULL DEFAULT '{}',
  winner TEXT NOT NULL CHECK(winner IN ('baseline','candidate','tie')),
  critical_regression INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(benchmark_run_id,case_id)
);
CREATE TABLE IF NOT EXISTS strategy_decisions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  benchmark_run_id TEXT REFERENCES benchmark_runs(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','rollback')),
  previous_strategy_id TEXT REFERENCES strategy_versions(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_goals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  pack_id TEXT,
  success_criteria_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','planned','approved','running','paused','partial','completed','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_goals_project ON agent_goals(project_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS run_plan_details (
  plan_id TEXT PRIMARY KEY REFERENCES run_plans(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL,
  edited_at TEXT,
  approved_at TEXT,
  approval_record_id TEXT
);
CREATE TABLE IF NOT EXISTS run_plan_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES run_plans(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','superseded')),
  plan_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,revision,decision)
);
CREATE TABLE IF NOT EXISTS run_step_details (
  step_id TEXT PRIMARY KEY REFERENCES run_steps(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  inputs_json TEXT NOT NULL DEFAULT '{}',
  expected_evidence TEXT NOT NULL DEFAULT '',
  verification_criteria TEXT NOT NULL DEFAULT '',
  approval_policy TEXT NOT NULL CHECK(approval_policy IN ('auto-read','individual-approval')),
  tool_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS run_step_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(step_id,attempt)
);
CREATE TABLE IF NOT EXISTS run_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  citation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_evidence_run ON run_evidence(run_id,created_at);
CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  project_artifact_id TEXT REFERENCES project_artifacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id,created_at);
CREATE TABLE IF NOT EXISTS run_journal_mappings (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  evolv_id TEXT NOT NULL UNIQUE,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','conflict','missing','complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const ENGINEERING_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS engineering_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_engineering_actions_status ON engineering_actions(status, created_at DESC);
`;

const MARKETPLACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS marketplace_installed (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  granted_permissions_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  error TEXT NOT NULL DEFAULT '',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS marketplace_logs (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_logs_pack ON marketplace_logs(pack_id, created_at DESC);
CREATE TABLE IF NOT EXISTS marketplace_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_secrets (
  pack_id TEXT NOT NULL REFERENCES marketplace_installed(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(pack_id, field_name)
);
CREATE TABLE IF NOT EXISTS marketplace_publishers (
  key_id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  publisher_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_remote_catalog (
  id INTEGER PRIMARY KEY CHECK(id=1),
  url TEXT NOT NULL,
  etag TEXT NOT NULL DEFAULT '',
  catalog_json TEXT,
  publisher_key_id TEXT NOT NULL DEFAULT '',
  generated_at TEXT,
  expires_at TEXT,
  fetched_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS marketplace_review_backend (
  id INTEGER PRIMARY KEY CHECK(id=1),
  url TEXT NOT NULL,
  publisher_key_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_review_cache (
  pack_id TEXT PRIMARY KEY,
  reviews_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_review_outbox (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  remote_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const VAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_connection (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  root_path TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_notes (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  format TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'obsidian',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_notes_title ON vault_notes(title);
CREATE INDEX IF NOT EXISTS idx_vault_notes_missing ON vault_notes(missing, status);
CREATE TABLE IF NOT EXISTS vault_chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_status TEXT NOT NULL DEFAULT 'lexical',
  UNIQUE(note_id, ordinal)
);
CREATE TABLE IF NOT EXISTS vault_links (
  id TEXT PRIMARY KEY,
  from_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'relates-to',
  UNIQUE(from_note_id, target_title, relation)
);
CREATE TABLE IF NOT EXISTS vault_sync_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS vault_changes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('create','edit','move','archive')),
  note_id TEXT,
  relative_path TEXT NOT NULL,
  destination_path TEXT NOT NULL DEFAULT '',
  before_content TEXT NOT NULL DEFAULT '',
  after_content TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','undone')),
  conversation_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_changes_status ON vault_changes(status, created_at DESC);
CREATE TABLE IF NOT EXISTS vault_change_backups (
  change_id TEXT PRIMARY KEY REFERENCES vault_changes(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  previous_content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const TOOL_RECIPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_recipe_proposals (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_recipe_versions (
  id TEXT PRIMARY KEY,
  macro_id TEXT NOT NULL REFERENCES tool_macros(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(macro_id, version)
);
`;

// A saved physics scene. The snapshot is opaque JSON on purpose: its shape is
// the engine's business, versioned inside the document itself, so adding a
// shape or a material never needs a migration here.
const PHYSICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS physics_scenes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  object_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_physics_scenes_updated ON physics_scenes(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_physics_scenes_name ON physics_scenes(name);
CREATE TABLE IF NOT EXISTS circuits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  part_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_circuits_updated ON circuits(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_circuits_name ON circuits(name);
`;

// What each model actually did last time it was asked. A provider's listing
// says what it offers, not what works; this is the record of the difference.
const MODEL_HEALTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_health (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  last_ok_at TEXT,
  last_failed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
`;

const SANDBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_run_id TEXT,
  conversation_id TEXT,
  root_path TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open'
    CHECK(state IN ('open','validating','validated','failed','promoted','discarded')),
  file_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_state ON sandbox_sessions(state, created_at DESC);

-- One row per file the simulation touched. base_sha256 is what the real
-- workspace held when the sandbox opened; promotion refuses if it moved.
CREATE TABLE IF NOT EXISTS sandbox_edits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sandbox_sessions(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','edit')),
  base_sha256 TEXT,
  next_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(session_id, relative_path)
);

CREATE TABLE IF NOT EXISTS sandbox_validations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sandbox_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_validations_session ON sandbox_validations(session_id, created_at);
`;

export const PROFILE_MIGRATIONS = Object.freeze([
  { version: 10, name: "core-schema", sql: CORE_SCHEMA },
  { version: 11, name: "engineering-actions", sql: ENGINEERING_ACTIONS_SCHEMA },
  { version: 12, name: "marketplace", sql: MARKETPLACE_SCHEMA },
  { version: 13, name: "obsidian-vault", sql: VAULT_SCHEMA },
  { version: 14, name: "tool-recipes", sql: TOOL_RECIPE_SCHEMA },
  { version: 15, name: "sandbox", sql: SANDBOX_SCHEMA },
  { version: 16, name: "physics-scenes", sql: PHYSICS_SCHEMA },
  { version: 17, name: "model-health", sql: MODEL_HEALTH_SCHEMA }
]);

export const LATEST_SCHEMA_VERSION = PROFILE_MIGRATIONS.at(-1).version;
