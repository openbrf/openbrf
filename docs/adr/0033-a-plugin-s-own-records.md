# ADR 0033: A plugin's own records

Date: 2026-10-19

## Status

Accepted.

## Context

A plugin has no place to keep anything of its own. Its settings are a form the
host draws from a declaration - text, numbers, booleans, a choice from a list -
and that is all the state the host holds for it. A plugin cannot bring tables or
migrations of its own (ADR 0003 loads a bundle, not a schema), and the database
is one of the core services a plugin may not inject.

That is enough for a plugin that formats what the core already holds. It is not
enough for one that has things of its own to remember. The signage module has
screens, each with a layout, a rotation, an entrance it hangs in and the addons
the board has switched on for it. None of that fits a settings form, and none of
it belongs anywhere but on the association's own instance.

## Decision

### A small keyed store per plugin

The host object gains `host.records`: JSON values under a collection and a key,
belonging to the plugin and to nothing else.

```ts
export interface PluginRecords {
  get<Value extends JsonValue>(
    collection: string,
    key: string,
  ): Promise<PluginRecord<Value> | null>;

  /** In key order. At most 200 per call. */
  list<Value extends JsonValue>(
    collection: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly PluginRecord<Value>[]>;

  /**
   * Writes a value. With `expectedRevision`, only over that revision, and
   * `null` means only where there is no record yet; otherwise it throws
   * PluginRecordConflictError.
   */
  put<Value extends JsonValue>(
    collection: string,
    key: string,
    value: Value,
    options?: { expectedRevision?: number | null },
  ): Promise<PluginRecord<Value>>;

  /** True when there was a record to delete. */
  delete(
    collection: string,
    key: string,
    options?: { expectedRevision?: number },
  ): Promise<boolean>;
}

export interface PluginRecord<Value extends JsonValue> {
  readonly collection: string;
  readonly key: string;
  readonly value: Value;
  readonly revision: number;
  readonly updatedAt: string;
}
```

- A collection name is lowercase letters, digits and single hyphens, at most 32
  characters; a key is 1 to 128 letters, digits, `.`, `_`, `:` or `-`.
- A value is JSON, at most 64 KiB serialised. A plugin holds at most 10 000
  records and 16 MiB in all; a write past either is refused with
  `PluginRecordLimitError`.
- `revision` is a counter, moved by every write, for the reason ADR 0008 gives
  for `Page.revision`: two writes inside one millisecond carry the same
  `updatedAt`.
- It needs no permission. A plugin's own records reach nobody else's data, and a
  plugin that keeps nothing never touches them.

They are stored in one table, `PluginRecord`, keyed by plugin, collection and
key, and cascading from the installed plugin.

### No personal data

**A plugin's records hold configuration, never people.** A screen's entrance is
an address id; a screen's name is the board's own text. A person's name, an
email address, an apartment someone holds or anything copied out of the register
does not belong there, and neither does a personal identity number, which the
host refuses on every write as it does on a page.

The reason is the rest of the platform rather than the store. The data subject
access report, purging, erasure, restriction and the record of processing
activities all read the core's own tables, and every column that names a person
is answered for by name (ADR 0019). A plugin's JSON is opaque to all of them, so
personal data written there would be data the association holds and cannot
report, purge or restrict. A plugin that needs to keep personal data is a core
feature request, as a plugin that needs to change resident data is.

The rule is declared, not enforced: the host cannot tell a name from a label.
The catalog's review of a plugin's server bundle reads its writes to
`host.records`, and the plugin contract states the rule beside the store.

### Removing, switching off, backups

Removing a plugin deletes its records, and the remove screen says so before the
board confirms. Switching a plugin off keeps them, and the host object refuses
until it is on again. The records are in the instance's database, so the
instance's backup carries them and a restore brings them back with everything
else.

A secret a plugin keeps in its records - an API key for a service of its own - is
readable by anyone who can read the database. The host does not encrypt records,
because a plugin runs in the same process as the key that would. A credential
belongs in a secret setting instead, which the host stores encrypted, never
returns through the API, and keeps out of the audit log and exports (ADR 0037).

## Consequences

- A plugin can have state of its own without a schema of its own, and without
  the instance taking a migration from a downloaded package.
- Another core service the seal keeps wrapped. The host stamps the plugin's id
  on every read and write, so a plugin cannot read another's records.
- `host.records` is added after this contract version shipped and is
  feature-detected.

## Rejected alternatives

- **Migrations shipped by a plugin.** A downloaded package changing the schema
  of the database the statutory registers live in, at boot, from code the
  instance runs at full privilege.
- **Keeping a module's configuration with a hosted service.** For signage that
  would put the association's own screens, and which entrance each hangs in, on
  Apteo's servers, and make the instance ask Apteo what its own screens show.
- **More field types in settings.** A settings form is one form; a list of
  screens, each with its own rotation, is not a form.

## Revisit triggers

- **A plugin needs to query its records** by something other than the key.
- **A plugin needs to keep personal data**: that is a core feature, with its
  own section in the data subject access report.
