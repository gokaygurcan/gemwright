import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { DotnetSettings, ShardConfig } from '@gemwright/common/config/types';
import { generatedOwnerPassword, validateOwner, validateOwnerPassword } from '@gemwright/server/emulators/accounts';
import { fetchDotnetFiles, prepareDotnetFiles } from '@gemwright/server/emulators/dotnet/config';

import * as prompts from '@clack/prompts';

import { answer } from '../../prompts';

export async function initializeDotnet(config: ShardConfig, yes = false, loadFiles = fetchDotnetFiles) {
  const upstream = await loadFiles(config);
  const clientFiles = yes
    ? ''
    : answer(
        await prompts.text({
          message: 'UO client files directory (optional; leave blank to add at deploy)',
          validate: async (value) => {
            if (!value) return;
            if (!(await stat(resolve(value)).catch(() => undefined))?.isDirectory())
              return 'Choose an existing directory.';
          }
        })
      );
  const autoCreateAccounts = yes
    ? true
    : answer(
        await prompts.confirm({ message: 'Allow players to create accounts on first login?', initialValue: true })
      );
  const owner = yes
    ? 'admin'
    : answer(
        await prompts.text({
          message: 'Owner username',
          defaultValue: 'admin',
          placeholder: 'admin',
          validate: (value) => validateOwner(value || 'admin')
        })
      );
  let password = yes
    ? ''
    : answer(
        await prompts.password({
          message: 'Owner password (leave blank to generate)',
          validate: (value) => validateOwnerPassword(value ?? '')
        })
      );
  const generatedPassword = password ? undefined : generatedOwnerPassword();
  password ||= generatedPassword ?? '';
  const settings: DotnetSettings = {
    owner,
    autoCreateAccounts,
    ...(clientFiles ? { clientFiles: resolve(clientFiles) } : {})
  };
  return { settings, files: prepareDotnetFiles(upstream, config, settings, password), generatedPassword };
}
