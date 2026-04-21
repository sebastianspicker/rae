def is_rfc3339:
  type == "string"
  and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$");

(.schema_version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
and (.project | type == "string" and length > 0)
and ([keys[] as $k | select(($allowed_root_keys | index($k)) == null)] | length == 0)
and (
  (has("$schema") | not)
  or (."$schema" | type == "string" and length > 0)
)
and (
  (has("branch_name") | not)
  or (.branch_name | type == "string" and length > 0)
)
and (
  (has("branchName") | not)
  or (.branchName | type == "string" and length > 0)
)
and (
  if (has("branch_name") and has("branchName")) then
    .branch_name == .branchName
  else
    true
  end
)
and (.defaults | type == "object")
and ((.defaults | keys | sort) == ($required_defaults_keys | sort))
and (.defaults.mode_default as $default_mode | ($supported_modes | index($default_mode) != null))
and (
  (
    (.defaults.max_stories_default | type == "number")
    and (.defaults.max_stories_default >= 0)
    and ((.defaults.max_stories_default | floor) == .defaults.max_stories_default)
  )
  or
  (.defaults.max_stories_default == "all_open")
)
and (.defaults.model_default | type == "string" and length > 0)
and (
  .defaults.reasoning_effort_default == "low"
  or .defaults.reasoning_effort_default == "medium"
  or .defaults.reasoning_effort_default == "high"
)
and (
  .defaults.report_dir
  | type == "string"
  and length > 0
  and test("^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$")
)
and (
  (.defaults.sandbox_by_mode | type == "object")
  and ((.defaults.sandbox_by_mode | keys | sort) == ["audit","fixing","linting"])
  and (.defaults.sandbox_by_mode.audit == "read-only")
  and (.defaults.sandbox_by_mode.linting == "read-only")
  and (.defaults.sandbox_by_mode.fixing == "workspace-write")
)
and (
  .defaults.lint_detection_order
  | type == "array"
  and length > 0
  and all(.[]; type == "string" and length > 0)
)
and (.stories | type == "array" and length > 0)
and ([.stories[].id] | length == (unique | length))
and (
  .stories
  | all(
      .[];
      (. as $story | [$required_story_keys[] | . as $k | select($story | has($k) | not)] | length == 0)
      and ([keys[] as $k | select(($allowed_story_keys | index($k)) == null)] | length == 0)
      and (.id | type == "string" and test("^(AUDIT|LINT|FIX)-[0-9]{3}$"))
      and (.title | type == "string" and length > 0)
      and (.priority | type == "number" and . >= 1 and floor == .)
      and (.mode as $mode | ($supported_modes | index($mode) != null))
      and (.scope | type == "array" and length > 0)
      and (.scope | all(.[]; type == "string" and length > 0))
      and (.acceptance_criteria | type == "array" and length > 0)
      and (.acceptance_criteria | all(.[]; type == "string" and length > 0))
      and (
        [.acceptance_criteria[] | select(test($created_regex))]
        | length == 1
      )
      and (.passes | type == "boolean")
      and (
        if has("skipped") then
          (.skipped | type == "boolean")
        else
          true
        end
      )
      and (
        if has("objective") then
          (.objective | type == "string" and length > 0)
        else
          true
        end
      )
      and (
        if has("verification") then
          (.verification | type == "array" and all(.[]; type == "string" and length > 0))
        else
          true
        end
      )
      and (
        if has("out_of_scope") then
          (.out_of_scope | type == "array" and all(.[]; type == "string" and length > 0))
        else
          true
        end
      )
      and (
        if has("notes") then
          (.notes | type == "string")
        else
          true
        end
      )
      and (
        if has("steps") then
          (
            .steps
            | type == "array"
            and length > 0
            and all(
                .[];
                type == "object"
                and ([keys[] as $k | select(($allowed_step_keys | index($k)) == null)] | length == 0)
                and ((has("id") | not) or (.id | type == "string" and length > 0))
                and (.title | type == "string" and length > 0)
                and (.actions | type == "array" and length > 0 and all(.[]; type == "string" and length > 0))
                and (.expected_evidence | type == "array" and length > 0 and all(.[]; type == "string" and length > 0))
                and (.done_when | type == "array" and length > 0 and all(.[]; type == "string" and length > 0))
              )
          )
        else
          true
        end
      )
      and (
        if .passes == true then
          (
            (.report_path | type == "string")
            and (.report_path | test("^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+\\.md$"))
            and (.completed_at | is_rfc3339)
            and ((.skipped // false) == false)
          )
        else
          ((has("report_path") | not) and (has("completed_at") | not))
        end
      )
      and (
        if ((.skipped // false) == true) then
          (
            (.passes == false)
            and (.skip_reason | type == "string" and length > 0)
            and (.skipped_at | is_rfc3339)
          )
        else
          ((has("skip_reason") | not) and (has("skipped_at") | not))
        end
      )
    )
)
