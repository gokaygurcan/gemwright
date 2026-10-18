import { relative, resolve } from 'node:path';

import * as prompts from '@clack/prompts';

import {
  configFilename,
  createConfig,
  defaultAdminEmail,
  defaultEmulator,
  defaultExpansion,
  defaultName,
  defaultTimezone,
  defaultWebsite,
  emulators,
  expansions,
  timezoneOptions,
  validateAdminEmail,
  validateName,
  validateWebsite
} from './config';
import { initializeDotnet } from './emulators/dotnet/init';
import { resolveDotnetSource } from './emulators/dotnet/source';
import { fetchServuoConfig } from './emulators/servuo/config';
import { initializeServuo } from './emulators/servuo/init';
import { resolveLatestServuoSource } from './emulators/servuo/source';
import { fetchSphereFiles, validateSphereName } from './emulators/sphere/config';
import { initializeSphere } from './emulators/sphere/init';
import { resolveLatestSphereSources } from './emulators/sphere/source';
import { ensureNewConfig, existingAncestor, gitStatus, type InstanceFiles, saveInstance } from './instance';
import { answer } from './prompts';

export interface InitOptions {
  directory?: string;
  name?: string;
  timezone?: string;
  expansion?: string;
  emulator?: string;
  git?: boolean;
  yes?: boolean;
  mysql?: boolean;
}

export async function initialize(
  options: InitOptions,
  resolveServuoSource = resolveLatestServuoSource,
  loadServuoConfig = fetchServuoConfig,
  resolveSphereSources = resolveLatestSphereSources,
  loadSphereFiles = fetchSphereFiles
): Promise<void> {
  const directory = resolve(options.directory ?? '.');
  await existingAncestor(directory);
  await ensureNewConfig(directory);
  // Validate supplied flags before starting the questionnaire or writing files.
  createConfig({
    name: options.name,
    timezone: options.timezone,
    expansion: options.expansion,
    emulator: options.emulator
  });
  const git = await gitStatus(directory);
  if (options.git && !git.available) throw new Error('Git is not installed. Install Git or omit --git.');
  if (!options.yes && !process.stdin.isTTY) {
    throw new Error('The questionnaire requires an interactive terminal. Use --yes to accept defaults.');
  }

  prompts.intro('Create an Ultima Online shard');
  const name =
    options.name ??
    (options.yes
      ? defaultName
      : answer(
          await prompts.text({
            message: 'Shard name',
            placeholder: defaultName,
            defaultValue: defaultName,
            validate: (value) => validateName(value ?? '')
          })
        ));
  const emulator =
    options.emulator ??
    (options.yes
      ? defaultEmulator
      : answer(
          await prompts.select({
            message: 'Which server emulator?',
            initialValue: defaultEmulator,
            options: [...emulators]
          })
        ));
  if (options.mysql && emulator !== 'sphere' && emulator !== 'sphere-x')
    throw new Error('--mysql is only supported by Sphere and Sphere-X.');
  if (emulator === 'sphere' || emulator === 'sphere-x') {
    const error = validateSphereName(name);
    if (error) throw new Error(error);
  }
  const timezone =
    options.timezone ??
    (options.yes
      ? defaultTimezone()
      : answer(
          await prompts.autocomplete({
            message: 'Timezone',
            placeholder: 'Type to search IANA zones',
            initialValue: defaultTimezone(),
            options: timezoneOptions().map((value) => ({ value })),
            maxItems: 8
          })
        ));
  const expansion =
    options.expansion ??
    (options.yes
      ? defaultExpansion
      : answer(
          await prompts.select({
            message: 'Expansion',
            initialValue: defaultExpansion,
            options: expansions.map((option) => ({
              ...option,
              ...((emulator === 'sphere' || emulator === 'sphere-x') && option.value === 'ej'
                ? { hint: 'Uses Time of Legends features in Sphere' }
                : {})
            }))
          })
        ));
  const adminEmail = options.yes
    ? defaultAdminEmail
    : answer(
        await prompts.text({
          message: 'Admin email (optional)',
          placeholder: defaultAdminEmail,
          defaultValue: defaultAdminEmail,
          validate: (value) => validateAdminEmail(value || defaultAdminEmail)
        })
      );
  const url = options.yes
    ? defaultWebsite
    : answer(
        await prompts.text({
          message:
            emulator === 'sphere' || emulator === 'sphere-x'
              ? 'Shard website (optional; omit http(s)://)'
              : 'Shard website (optional)',
          placeholder: defaultWebsite,
          defaultValue: defaultWebsite,
          validate: (value) =>
            (emulator === 'sphere' || emulator === 'sphere-x') && value?.includes('//')
              ? 'Sphere requires a hostname/path without http(s):// or //.'
              : validateWebsite(value || defaultWebsite)
        })
      );
  const sphereSources =
    emulator === 'sphere' || emulator === 'sphere-x' ? await resolveSphereSources(undefined, emulator) : undefined;
  const source =
    emulator === 'servuo'
      ? await resolveServuoSource()
      : emulator === 'runuo' || emulator === 'modernuo'
        ? await resolveDotnetSource(emulator)
        : sphereSources?.server;
  let files: InstanceFiles = {};
  let generatedPassword: string | undefined;
  let config = createConfig({ name, emulator, timezone, expansion, source, adminEmail, url });
  if (emulator === 'servuo') {
    const result = await initializeServuo(config, options.yes, loadServuoConfig);
    config = createConfig({ ...config, servuo: result.settings });
    files = result.files;
    generatedPassword = result.generatedPassword;
  } else if (emulator === 'runuo' || emulator === 'modernuo') {
    const result = await initializeDotnet(config, options.yes);
    config = createConfig({ ...config, [emulator]: result.settings });
    files = result.files;
    generatedPassword = result.generatedPassword;
  } else if (sphereSources) {
    const result = await initializeSphere(config, sphereSources, options.yes, loadSphereFiles, options.mysql);
    config = createConfig({ ...config, sphere: result.settings });
    files = result.files;
    generatedPassword = result.generatedPassword;
  }
  const initializeGit =
    git.available &&
    !git.insideRepository &&
    (options.git ??
      (options.yes
        ? true
        : answer(
            await prompts.confirm({
              message: 'Initialize a Git repository?',
              initialValue: true
            })
          )));

  await saveInstance(directory, config, initializeGit, files);
  if (generatedPassword)
    prompts.note(
      `Username: ${config.servuo?.owner ?? config.sphere?.owner ?? config.runuo?.owner ?? config.modernuo?.owner}\nPassword: ${generatedPassword}\nSave this password; it will not be shown again.`,
      'Owner account'
    );
  const target = relative(process.cwd(), directory);
  const commands = [];
  if (target) {
    const path = /^[\w./-]+$/.test(target) ? target : `'${target.replaceAll("'", "'\\''")}'`;
    commands.push(`cd -- ${path}`);
  }
  commands.push('gemwright deploy');
  prompts.outro(`Created ${configFilename} in ${directory}\n\nNext steps:\n  ${commands.join('\n  ')}`);
}
