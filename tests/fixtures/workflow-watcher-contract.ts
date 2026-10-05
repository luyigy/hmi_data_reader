export const workflowWatcherContract = `
schema_version: 2
contract_version: test
documents:
  automation_types: [PLAN, HANDOVER]
  filename_pattern: "^(?P<number>[0-9]+)_(?P<doc_type>[A-Z]+)_(?P<date>[0-9]{8})_.+\\\\.md$"
  slice_pattern: "\\\\bS[0-9]{2,}\\\\b"
  statuses: [draft, ready, completed]
  common_required_fields: [doc_type, doc_status, next_action]
  plan:
    required_fields: [plan_kind, roadmap, parent_plan, parent_slice, return_to]
    required_fields_by_kind:
      interrupt: [parent_plan, parent_slice, return_to]
    kinds: [phase, interrupt]
    executable_actions: [start_first_slice]
    review_action: await_approval
    start_action: start_first_slice
    start_status: ready
    interrupt_kind: interrupt
    phase_kind: phase
    parent_fields: [parent_plan, parent_slice, return_to]
  handover:
    required_fields: [plan, slice, plan_progress]
    progress_values: [in_progress, complete]
    executable_actions: [next_slice, resume_parent]
    next_action: next_slice
    resume_action: resume_parent
actions:
  executable: [start_first_slice, next_slice, resume_parent]
  review: [await_approval]
  terminal: [await_acceptance, blocked, none]
prompt:
  start_marker: "<!-- WORKFLOW_PROMPT_START -->"
  end_marker: "<!-- WORKFLOW_PROMPT_END -->"
completion_gate:
  timeout_seconds: 1800
branch_spaces:
  root: docs/branch
numbering:
  width: 3
  unique: true
  candidate_selection: highest_changed_number
legacy:
  cutoff_commit: null
  automation_enabled: true
`;
