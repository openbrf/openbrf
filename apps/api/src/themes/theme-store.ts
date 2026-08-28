import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { isPackagePath, type ThemeArchiveFiles } from "@openbrf/theme-tools";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";

/** A theme's files written to the volume but not yet the installed version. */
export interface StagedTheme {
  /** Moves the staged files into place, replacing any earlier version. */
  commit(): Promise<void>;
  /** Removes the staged files. Any earlier version is left exactly as it was. */
  discard(): Promise<void>;
}

/**
 * Installed themes on the data volume, under <data dir>/themes/<theme id>.
 *
 * A theme's files are served back to browsers - fonts and a logo - so every
 * path that reaches the filesystem is checked twice: once against the package
 * path rules, and once by resolving it and proving the result is still inside
 * the theme's own directory. The second check is what makes the first one
 * safe to rely on, because it holds regardless of what the first one missed.
 *
 * Writing is staged, and committing it is a separate step the caller takes once
 * the database has accepted the install. Two systems cannot share a
 * transaction, so the database is made the decider: a transaction that fails
 * leaves the previous version untouched, and a crash halfway through an install
 * leaves a staging directory behind rather than a half-written theme the
 * interface would try to render.
 */
@Injectable()
export class ThemeStore {
  private readonly logger = new Logger(ThemeStore.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** The directory every installed theme sits under. */
  get root(): string {
    return resolve(join(this.env.OPENBRF_DATA_DIR, "themes"));
  }

  directoryFor(themeId: string): string {
    return join(this.root, themeId);
  }

  /**
   * Writes a theme's files to a staging directory beside the installed one.
   *
   * The staging directory is a sibling rather than a temporary directory
   * elsewhere, so the move into place is a rename within one filesystem and
   * therefore atomic. Nothing the interface reads changes until the returned
   * handle is committed, so a caller that fails after staging - a refused
   * database transaction, say - discards it and the installed version is
   * exactly what it was.
   */
  async stage(themeId: string, files: ThemeArchiveFiles): Promise<StagedTheme> {
    const suffix = randomBytes(6).toString("hex");
    const staging = join(this.root, `.staging-${themeId}-${suffix}`);
    const target = this.directoryFor(themeId);
    const displaced = join(this.root, `.replaced-${themeId}-${suffix}`);

    await mkdir(staging, { recursive: true });

    try {
      for (const [path, contents] of files) {
        if (!isPackagePath(path)) {
          throw new Error(`The package contains an unusable path: ${path}`);
        }
        const destination = this.containedPath(staging, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, contents);
      }
    } catch (cause) {
      await rm(staging, { recursive: true, force: true });
      throw cause;
    }

    return {
      commit: async () => {
        /*
         * The previous version is moved aside rather than deleted, and it goes
         * back if the swap fails. It is the version the interface is rendering:
         * losing it would leave the association's fonts and logo answering 404
         * on every page until somebody reinstalled the theme.
         */
        let displacedPrevious = false;
        try {
          await rename(target, displaced);
          displacedPrevious = true;
        } catch {
          // Nothing to displace: this is a first install.
        }

        try {
          await rename(staging, target);
        } catch (cause) {
          if (displacedPrevious) {
            await rename(displaced, target).catch(() => undefined);
          }
          await rm(staging, { recursive: true, force: true });
          throw cause;
        }

        if (displacedPrevious) {
          await rm(displaced, { recursive: true, force: true });
        }
        this.logger.log(`Wrote theme ${themeId} to ${target}`);
      },
      discard: async () => {
        await rm(staging, { recursive: true, force: true });
      },
    };
  }

  async remove(themeId: string): Promise<void> {
    await rm(this.directoryFor(themeId), { recursive: true, force: true });
    this.logger.log(`Removed theme ${themeId}`);
  }

  /**
   * Reads one file from an installed theme.
   *
   * Returns null rather than throwing for a file that is not there, because
   * the caller is answering an HTTP request and a missing asset is a 404, not
   * a fault.
   */
  async readAsset(themeId: string, path: string): Promise<Buffer | null> {
    if (!isPackagePath(path)) {
      return null;
    }
    try {
      return await readFile(
        this.containedPath(this.directoryFor(themeId), path),
      );
    } catch {
      return null;
    }
  }

  /**
   * Joins a path and proves the result stays inside the directory.
   *
   * The package path rules already refuse `..`, an absolute path and a
   * backslash. This is the check that does not depend on those rules being
   * complete: whatever the path was, the resolved result must still be under
   * the theme's own directory or nothing is read or written.
   */
  private containedPath(directory: string, path: string): string {
    const base = resolve(directory);
    const target = resolve(join(base, path));
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`The path ${path} escapes ${base}.`);
    }
    return target;
  }
}
