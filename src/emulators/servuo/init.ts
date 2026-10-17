import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as prompts from '@clack/prompts';

import type { ShardConfig } from '../../config';
import { answer } from '../../prompts';
import { generatedOwnerPassword, validateOwner, validateOwnerPassword } from '../accounts';
import { configValue, fetchServuoConfig, prepareServuoFiles, type ServuoSettings } from './config';

export async function initializeServuo(config: ShardConfig, yes = false, loadConfig = fetchServuoConfig) {
  let generatedPassword: string | undefined;

  const upstream = await loadConfig(config.source!);
  const registration = configValue(upstream['Config/Accounts.cfg'] ?? '', 'AutoCreateAccounts');
  if (!registration || !/^(true|false)$/i.test(registration))
    throw new Error('Upstream automatic registration default is missing or invalid.');
  const clientFiles = yes
    ? ''
    : answer(
        await prompts.text({
          message: 'UO client files directory (optional; leave blank to add at deploy)',
          validate: async (value) => {
            if (!value) return;
            try {
              if (!(await stat(resolve(value))).isDirectory()) return 'Choose a directory.';
            } catch {
              return 'That directory does not exist.';
            }
          }
        })
      );
  const autoCreateAccounts = yes
    ? registration.toLowerCase() === 'true'
    : answer(
        await prompts.confirm({
          message: 'Allow players to create accounts on first login?',
          initialValue: registration.toLowerCase() === 'true'
        })
      );
  const accountDefault = configValue(upstream['Config/Accounts.cfg'] ?? '', 'AccountsPerIp');
  if (!accountDefault || !/^\d+$/.test(accountDefault) || Number(accountDefault) > 2147483647)
    throw new Error('Upstream accounts per IP default is missing or invalid.');
  const chatDefault = configValue(upstream['Config/Chat.cfg'] ?? '', 'Enabled');
  if (!chatDefault || !/^(true|false)$/i.test(chatDefault))
    throw new Error('Upstream global chat default is missing or invalid.');
  const clientOptions = [
    { value: 'AllowRegular', label: 'Classic client' },
    { value: 'AllowUOTD', label: 'Third Dawn client' },
    { value: 'AllowGod', label: 'God client' },
    { value: 'AllowEC', label: 'Enhanced client' }
  ];
  const clientDefaults = clientOptions
    .filter(({ value }) => {
      const enabled = configValue(upstream['Config/Client.cfg'] ?? '', value);
      if (!enabled || !/^(true|false)$/i.test(enabled))
        throw new Error(`Upstream client default is missing or invalid: ${value}`);
      return enabled.toLowerCase() === 'true';
    })
    .map(({ value }) => value);
  const accountsPerIp = yes
    ? Number(accountDefault)
    : Number(
        answer(
          await prompts.text({
            message: 'Accounts allowed per IP address',
            defaultValue: accountDefault,
            placeholder: accountDefault,
            validate: (value) =>
              value && (!/^\d+$/.test(value) || Number(value) > 2147483647)
                ? 'Enter a whole number between 0 and 2147483647.'
                : undefined
          })
        )
      );
  const globalChat = yes
    ? chatDefault.toLowerCase() === 'true'
    : answer(
        await prompts.confirm({
          message: 'Enable global chat?',
          initialValue: chatDefault.toLowerCase() === 'true'
        })
      );
  const allowedClients = yes
    ? clientDefaults
    : answer(
        await prompts.multiselect({
          message: 'Allowed clients',
          options: clientOptions,
          initialValues: clientDefaults,
          required: true
        })
      );
  const owner = yes
    ? 'admin'
    : answer(
        await prompts.text({
          message: 'Owner username',
          placeholder: 'admin',
          defaultValue: 'admin',
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
  if (!password) password = generatedPassword = generatedOwnerPassword();
  const settings: ServuoSettings = {
    ...(clientFiles ? { clientFiles: resolve(clientFiles) } : {}),
    autoCreateAccounts,
    accountsPerIp,
    globalChat,
    allowedClients,
    owner
  };
  return { settings, files: prepareServuoFiles(upstream, config, settings, password), generatedPassword };
}
