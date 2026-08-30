// @vitest-environment jsdom

// A single coverage isolate avoids a Node 24 / @bcoe/v8-coverage range-tree
// recursion bug when the same transformed module is merged across test files.
// The normal test command still runs each source test independently.
import '../unit/task-history.test'
import '../unit/timeline.test'
import '../unit/agent-bridge-extension-ui.test'
import '../unit/optimistic-session.test'
import '../unit/working-status.test'
import '../unit/run-store.test'
import '../unit/plugin-manager.test'
import '../unit/verification.test'
import '../unit/git-service.test'
import '../unit/workflow-manager.test'
import '../renderer/ConfirmDialog.test'
import '../renderer/Composer.test'
import '../renderer/ExtensionUiModal.test'
import '../renderer/HistoryNavigator.test'
import '../renderer/OperationsModal.test'
import '../renderer/RunMetricsStrip.test'
import '../renderer/SessionList.test'
import '../renderer/TaskPanel.test'
import '../renderer/VerificationPanel.test'
import '../renderer/WorkflowPanel.test'
