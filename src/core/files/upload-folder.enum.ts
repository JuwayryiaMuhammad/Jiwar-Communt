/**
 * Where an upload may go, under the tenant's prefix (ADR 0029). A closed
 * list, never a path from the client: that would be bucket pollution and
 * traversal.
 *
 * Empty on purpose: a folder is added with the feature that stores files in
 * it (worker photos, registration documents, …), not ahead of it.
 */
export enum UploadFolder {}
