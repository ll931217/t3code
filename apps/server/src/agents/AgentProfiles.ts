import {
  AgentProfile,
  AgentDelegationWritablePaths,
  AgentProfileError,
  AgentProfileRepositoryFile,
  type AgentProfileCatalogEntry,
  type AgentProfileId,
  type AgentProfileScope,
  type AgentProfileSnapshot,
  type AgentProfileVersion,
  type AgentProfilePinInput,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as AgentProfileStore from "./AgentProfileStore.ts";

const decodeWritablePaths = Schema.decodeEffect(AgentDelegationWritablePaths);
const decodeProfile = Schema.decodeUnknownEffect(AgentProfile, { onExcessProperty: "error" });
const decodeRepository = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentProfileRepositoryFile),
  { onExcessProperty: "error" },
);
const encodeRepository = Schema.encodeEffect(Schema.fromJsonString(AgentProfileRepositoryFile));
const isProfileError = Schema.is(AgentProfileError);
const profileFileName = "t3.profiles.json";

export class AgentProfiles extends Context.Service<
  AgentProfiles,
  {
    readonly list: (
      scope: AgentProfileScope,
    ) => Effect.Effect<ReadonlyArray<AgentProfileCatalogEntry>, AgentProfileError>;
    readonly savePersonal: (profile: AgentProfile) => Effect.Effect<void, AgentProfileError>;
    readonly saveRepository: (
      scope: AgentProfileScope,
      profile: AgentProfile,
    ) => Effect.Effect<void, AgentProfileError>;
    readonly remove: (
      scope: AgentProfileScope,
      profileId: AgentProfileId,
    ) => Effect.Effect<void, AgentProfileError>;
    readonly reviewTrust: (
      scope: AgentProfileScope,
      profileId: AgentProfileId,
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly trust: (
      scope: AgentProfileScope,
      profileId: AgentProfileId,
      expectedFingerprint: string,
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly resolveSnapshot: (
      scope: AgentProfileScope,
      profileId: AgentProfileId,
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly getSnapshot: (
      id: string,
    ) => Effect.Effect<AgentProfileSnapshot | null, AgentProfileError>;
    readonly deriveSnapshot: (
      parentId: string,
      profileId: AgentProfileId,
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly narrowSnapshot: (
      snapshotId: string,
      writablePaths: readonly string[],
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly getThreadSnapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentProfileSnapshot | null, AgentProfileError>;
    readonly pinThread: (input: AgentProfilePinInput) => Effect.Effect<void, AgentProfileError>;
    readonly applyThreadSnapshot: (
      input: AgentProfilePinInput,
    ) => Effect.Effect<void, AgentProfileError>;
    readonly assertSnapshotAllowed: (id: string) => Effect.Effect<void, AgentProfileError>;
    readonly revoke: (id: string) => Effect.Effect<ReadonlyArray<ThreadId>, AgentProfileError>;
  }
>()("t3/agents/AgentProfiles") {}

const make = Effect.gen(function* () {
  const store = yield* AgentProfileStore.AgentProfileStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const writes = yield* Semaphore.make(1);

  const fingerprint = Effect.fn("AgentProfiles.fingerprint")(
    function* (value: unknown) {
      return Hex.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(stableStringify(value))),
      );
    },
    Effect.mapError((cause) => new AgentProfileError({ reason: "storage", cause })),
  );

  const readRepository = Effect.fn("AgentProfiles.readRepository")(function* (
    scope: AgentProfileScope,
  ) {
    const filePath = path.join(scope.workspaceRoot, profileFileName);
    const raw = yield* fs.readFileString(filePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(new AgentProfileError({ reason: "storage", cause })),
      }),
    );
    if (raw === null) return { version: 1 as const, profiles: [] };
    return yield* decodeRepository(raw).pipe(
      Effect.mapError((cause) => new AgentProfileError({ reason: "invalid-document", cause })),
    );
  });

  const writeRepository = Effect.fn("AgentProfiles.writeRepository")(
    function* (scope: AgentProfileScope, document: AgentProfileRepositoryFile) {
      const filePath = path.join(scope.workspaceRoot, profileFileName);
      const realRoot = yield* fs.realPath(scope.workspaceRoot);
      const entry = yield* fs.lstat(filePath).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        }),
      );
      const realFile = yield* fs.realPath(filePath).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? entry?.type === "SymbolicLink"
                ? Effect.fail(new AgentProfileError({ reason: "wrong-scope" }))
                : Effect.succeed(path.join(realRoot, profileFileName))
              : Effect.fail(cause),
        }),
      );
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new AgentProfileError({ reason: "wrong-scope" });
      const contents = yield* encodeRepository(document);
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
    Effect.mapError((cause) =>
      isProfileError(cause) ? cause : new AgentProfileError({ reason: "storage", cause }),
    ),
  );

  const catalog = Effect.fn("AgentProfiles.catalog")(function* (scope: AgentProfileScope) {
    const personal = yield* store.personal();
    const repository = yield* readRepository(scope);
    return yield* Effect.forEach(
      [...personal, ...repository.profiles],
      Effect.fn("AgentProfiles.version")(function* (profile) {
        const sourceProjectId = profile.id.startsWith("project/") ? scope.projectId : null;
        return {
          profile,
          sourceProjectId,
          fingerprint: yield* fingerprint({ profile, sourceProjectId }),
        } satisfies AgentProfileVersion;
      }),
    );
  });

  const buildSnapshot = Effect.fn("AgentProfiles.buildSnapshot")(function* (
    versions: ReadonlyArray<AgentProfileVersion>,
    profileId: AgentProfileId,
  ) {
    const byId = new Map(versions.map((version) => [version.profile.id, version]));
    const root = byId.get(profileId);
    if (root === undefined) return yield* new AgentProfileError({ reason: "not-found", profileId });
    const visited = new Set<string>();
    const unresolved = new Set<string>();
    const dependencies: AgentProfileVersion[] = [];
    const remaining = [root];
    while (remaining.length > 0) {
      const current = remaining.pop()!;
      if (visited.has(current.profile.id)) continue;
      visited.add(current.profile.id);
      if (current.profile.id !== profileId) dependencies.push(current);
      for (const id of current.profile.delegation.profiles) {
        const child = byId.get(id);
        if (child === undefined) unresolved.add(id);
        else remaining.push(child);
      }
    }
    dependencies.sort((left, right) => left.profile.id.localeCompare(right.profile.id));
    const unresolvedProfiles = [...unresolved].sort();
    const id = yield* fingerprint({ root, dependencies, unresolvedProfiles });
    return {
      snapshot: { id, root, dependencies } satisfies AgentProfileSnapshot,
      unresolvedProfiles,
    };
  });

  const reviewTrust = Effect.fn("AgentProfiles.reviewTrust")(function* (
    scope: AgentProfileScope,
    profileId: AgentProfileId,
  ) {
    return (yield* buildSnapshot(yield* catalog(scope), profileId)).snapshot;
  });
  const assertSnapshotAllowed = Effect.fn("AgentProfiles.assertSnapshotAllowed")(function* (
    id: string,
  ) {
    const status = yield* store.status(id);
    if (!status.trusted || status.revoked)
      return yield* new AgentProfileError({ reason: status.revoked ? "revoked" : "untrusted" });
  });

  return AgentProfiles.of({
    list: Effect.fn("AgentProfiles.list")(function* (scope) {
      const versions = yield* catalog(scope);
      return yield* Effect.forEach(
        versions,
        Effect.fn("AgentProfiles.catalogEntry")(function* (version) {
          const { snapshot, unresolvedProfiles } = yield* buildSnapshot(
            versions,
            version.profile.id,
          );
          const status = yield* store.status(snapshot.id);
          return { version, reviewFingerprint: snapshot.id, ...status, unresolvedProfiles };
        }),
      );
    }),
    savePersonal: Effect.fn("AgentProfiles.savePersonal")(function* (input) {
      const profile = yield* decodeProfile(input).pipe(
        Effect.mapError((cause) => new AgentProfileError({ reason: "invalid-document", cause })),
      );
      if (!profile.id.startsWith("personal/"))
        return yield* new AgentProfileError({ reason: "wrong-scope", profileId: profile.id });
      yield* store.savePersonal(profile);
    }),
    saveRepository: Effect.fn("AgentProfiles.saveRepository")(function* (scope, input) {
      const profile = yield* decodeProfile(input).pipe(
        Effect.mapError((cause) => new AgentProfileError({ reason: "invalid-document", cause })),
      );
      if (!profile.id.startsWith("project/"))
        return yield* new AgentProfileError({ reason: "wrong-scope", profileId: profile.id });
      yield* writes.withPermit(
        Effect.gen(function* () {
          const document = yield* readRepository(scope);
          yield* writeRepository(scope, {
            version: 1,
            profiles: [...document.profiles.filter((item) => item.id !== profile.id), profile],
          });
        }),
      );
    }),
    remove: Effect.fn("AgentProfiles.remove")(function* (scope, profileId) {
      if (profileId.startsWith("personal/")) return yield* store.removePersonal(profileId);
      yield* writes.withPermit(
        Effect.gen(function* () {
          const document = yield* readRepository(scope);
          yield* writeRepository(scope, {
            version: 1,
            profiles: document.profiles.filter((profile) => profile.id !== profileId),
          });
        }),
      );
    }),
    reviewTrust,
    trust: Effect.fn("AgentProfiles.trust")(function* (scope, profileId, expectedFingerprint) {
      const snapshot = yield* reviewTrust(scope, profileId);
      if (snapshot.id !== expectedFingerprint)
        return yield* new AgentProfileError({ reason: "changed", profileId });
      yield* store.trust(snapshot);
      return snapshot;
    }),
    resolveSnapshot: Effect.fn("AgentProfiles.resolveSnapshot")(function* (scope, profileId) {
      const snapshot = yield* reviewTrust(scope, profileId);
      yield* assertSnapshotAllowed(snapshot.id);
      return snapshot;
    }),
    deriveSnapshot: Effect.fn("AgentProfiles.deriveSnapshot")(function* (parentId, profileId) {
      yield* assertSnapshotAllowed(parentId);
      const parent = yield* store.getSnapshot(parentId);
      if (parent === null) return yield* new AgentProfileError({ reason: "not-found" });
      if (!parent.root.profile.delegation.profiles.includes(profileId))
        return yield* new AgentProfileError({ reason: "wrong-scope", profileId });
      const { snapshot, unresolvedProfiles } = yield* buildSnapshot(
        [parent.root, ...parent.dependencies],
        profileId,
      );
      if (unresolvedProfiles.length > 0)
        return yield* new AgentProfileError({ reason: "not-found", profileId });
      yield* store.inherit(parentId, snapshot);
      return snapshot;
    }),
    narrowSnapshot: Effect.fn("AgentProfiles.narrowSnapshot")(function* (snapshotId, paths) {
      yield* assertSnapshotAllowed(snapshotId);
      const source = yield* store.getSnapshot(snapshotId);
      if (source === null) return yield* new AgentProfileError({ reason: "not-found" });
      const writablePaths = [
        ...new Set(
          yield* decodeWritablePaths(paths).pipe(
            Effect.mapError(
              (cause) => new AgentProfileError({ reason: "invalid-document", cause }),
            ),
          ),
        ),
      ].sort();
      const maximum = source.writablePaths ?? source.root.profile.permissions.writablePaths;
      if (
        maximum.length > 0 &&
        writablePaths.some(
          (path) => !maximum.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)),
        )
      )
        return yield* new AgentProfileError({ reason: "wrong-scope" });
      const { id: _id, ...body } = source;
      const narrowed = { ...body, writablePaths };
      const snapshot = { ...narrowed, id: yield* fingerprint(narrowed) };
      yield* store.inherit(snapshotId, snapshot);
      return snapshot;
    }),
    getSnapshot: store.getSnapshot,
    getThreadSnapshot: store.forThread,
    pinThread: Effect.fn("AgentProfiles.pinThread")((input) =>
      store.pin(input.threadId, input.snapshotId, false),
    ),
    applyThreadSnapshot: Effect.fn("AgentProfiles.applyThreadSnapshot")((input) =>
      store.pin(input.threadId, input.snapshotId, true),
    ),
    assertSnapshotAllowed,
    revoke: store.revoke,
  });
});

export const layer = Layer.effect(AgentProfiles, make).pipe(Layer.provide(AgentProfileStore.layer));
