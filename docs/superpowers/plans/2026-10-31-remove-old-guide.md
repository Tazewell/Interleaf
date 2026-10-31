# Remove old guide

User request: remove the current guide until new recordings are ready.

1. Remove the guide menu, first-run onboarding, guide preview route, canvas scenes/styles and old website demonstration video.
2. Extract offline update notes into independent release-notes components, preserving version acknowledgement in the legacy preferences bucket. Fresh installs silently acknowledge the current version; actual updates still show notes once.
3. Move the existing shortcut panel into Settings, preserving editable bindings and Escape cancellation.
4. Remove dead GuidePreferences/API names, obsolete demo topic links and current-version claims about removed guides; preserve historical release prose and user data.
5. Run focused regression tests, typecheck, production web build and content/reference checks; review, commit, merge, refresh preview. Do not push or publish.

Validation: typecheck, 45 related tests (9 files), Web production build, release-source validation, diff checks and all referenced website asset checks passed. Independent review found no important issues. Backend/user data unchanged; existing release acknowledgement bucket intentionally retained for compatibility.
