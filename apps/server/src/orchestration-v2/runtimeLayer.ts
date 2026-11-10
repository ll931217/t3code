import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as AgentProfiles from "../agents/AgentProfiles.ts";
import * as AgentProfileService from "../agents/AgentProfileService.ts";
import * as AgentProfileGate from "../agents/AgentProfileGate.ts";
import * as AgentProfileStops from "../agents/AgentProfileStops.ts";
import * as AgentProfileStopWorker from "../agents/AgentProfileStopWorker.ts";
import * as AgentExecutionStore from "../agents/AgentExecutionStore.ts";
import * as AgentExecutionService from "../agents/AgentExecutionService.ts";
import * as AgentExecutionObserver from "../agents/AgentExecutionObserver.ts";
import * as AgentDelegationStore from "../agents/AgentDelegationStore.ts";
import * as AgentDelegationRuntime from "../agents/AgentDelegationRuntime.ts";
import * as AgentProfileDelegation from "../agents/AgentProfileDelegation.ts";
import * as AgentDelegationAuthority from "../agents/AgentDelegationAuthority.ts";
import * as AgentDelegationAuthorityStore from "../agents/AgentDelegationAuthorityStore.ts";
import * as AgentDelegationPeerLaunch from "../agents/AgentDelegationPeerLaunch.ts";
import * as AgentWorktreeActions from "../agents/AgentWorktreeActions.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

export const layerAgentDelegationAuthority = AgentDelegationAuthority.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentDelegationAuthorityStore.layer,
      AgentDelegationStore.layer,
      AgentProfiles.layer,
      ProjectStore.layer,
    ),
  ),
);

const layerRuntimePolicyProvided = RuntimePolicy.layerEnforcingProfiles.pipe(
  Layer.provide(RuntimePolicy.layerFromProjectStore.pipe(Layer.provide(ProjectStore.layer))),
  Layer.provide(AgentProfiles.layer),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSink),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSink,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
      GitVcsDriver.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
);

const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.merge(layerEventSink, ProjectionStore.layer)),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCommandOutputHubProvided,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      PreviewAgentActivity.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      TurnItemPositionStore.layer,
    ),
  ),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(layerAgentDelegationAuthority),
  Layer.provide(AgentDelegationStore.layer),
  Layer.provide(
    Layer.mergeAll(
      layerContextHandoffServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
    ),
  ),
  (base) =>
    AgentProfileGate.layerProviderStart.pipe(
      Layer.provide(base),
      Layer.provide(AgentProfileGate.layer),
      Layer.provide(AgentProfileStops.layer),
    ),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    AgentProfileDelegation.layer.pipe(
      Layer.provide(layerAgentDelegationAuthority),
      Layer.provide(
        Layer.mergeAll(
          AgentProfiles.layer,
          AgentDelegationStore.layer,
          AgentDelegationAuthorityStore.layer,
        ),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSink,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
      // Reuse the continuation worker's layer reference so memoization shares one request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSink,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
  // Whether a thread came from a linked environment, which skips setup.
  Layer.provide(ProjectionStore.layer),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
);
const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerManagedProjectFoldersProvided,
      layerSecretRequestsProvided,
    ),
  ),
);
const layerScratchThreadPromotionProvided = ScratchThreadPromotion.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerScheduledTaskProvided,
    ),
  ),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerThreadManagementProvided, ProjectStore.layer, TextGeneration.layer),
  ),
);
const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSink,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerCommandOutputHubProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);

const layerProfileStopWorkerProvided = AgentProfileStopWorker.layer.pipe(
  Layer.provide(
    Layer.mergeAll(AgentProfileStops.layer, AgentProfileGate.layer, layerThreadManagementProvided),
  ),
);

export const layerProduction = Layer.mergeAll(
  AgentProfileStopWorker.layerWorker.pipe(Layer.provide(layerProfileStopWorkerProvided)),
  WorktreeBranchSync.layer.pipe(
    Layer.provide(Layer.merge(layerThreadManagementProvided, ProjectionStore.layer)),
  ),
  layer.pipe(Layer.provide(layerProjectService)),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  AgentProfiles.layer,
  AgentExecutionStore.layer,
  AgentExecutionObserver.layerWorker.pipe(
    Layer.provide(AgentExecutionObserver.layer),
    Layer.provide(Layer.mergeAll(AgentExecutionStore.layer, layerEventSink)),
  ),
  AgentDelegationStore.layer,
  AgentDelegationAuthorityStore.layer,
  layerAgentDelegationAuthority,
  AgentDelegationPeerLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerAgentDelegationAuthority,
        layerThreadLaunchProvided,
        ProjectionStore.layer,
      ),
    ),
  ),
  AgentProfileDelegation.layer.pipe(
    Layer.provide(layerAgentDelegationAuthority),
    Layer.provide(
      Layer.mergeAll(
        AgentProfiles.layer,
        AgentDelegationStore.layer,
        AgentDelegationAuthorityStore.layer,
      ),
    ),
  ),
  Layer.effectDiscard(
    Effect.flatMap(AgentDelegationRuntime.AgentDelegationRuntime, (runtime) =>
      forkParked(runtime.run),
    ),
  ).pipe(
    Layer.provide(AgentDelegationRuntime.layer),
    Layer.provide(layerAgentDelegationAuthority),
    Layer.provide(
      Layer.mergeAll(
        AgentDelegationStore.layer,
        ProjectionStore.layer,
        EffectOutbox.layer,
        layerEventSink,
      ),
    ),
  ),
  AgentProfileService.layer.pipe(
    Layer.provide(AgentProfileGate.layer),
    Layer.provide(layerProfileStopWorkerProvided),
    Layer.provide(
      Layer.mergeAll(
        AgentProfiles.layer,
        ProjectStore.layer,
        layerThreadLaunchProvided,
        layerThreadManagementProvided,
      ),
    ),
  ),
  AgentExecutionService.layer.pipe(
    Layer.provide(Layer.mergeAll(AgentExecutionStore.layer, layerThreadManagementProvided)),
  ),
  AgentWorktreeActions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        AgentProfiles.layer,
        AgentProfileGate.layer,
        layerThreadManagementProvided,
        ProjectStore.layer,
      ),
    ),
  ),
  layerScheduledTaskProvided,
  layerScratchThreadPromotionProvided,
  layerSecretRequestsProvided,
  GuestShareService.layer.pipe(
    Layer.provide(Layer.merge(layerOrchestratorProvided, layerCommandOutputHubProvided)),
  ),
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        layerThreadManagementProvided,
        layerOrchestratorProvided,
      ),
    ),
  ),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionImporterProvided,
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(
  Layer.provide(ResourceCleanupService.layer.pipe(Layer.provide(layerScheduledTaskProvided))),
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(layerEventInfrastructure),
);
