export class CommandRejected extends Error {
  constructor(
    readonly code: 'vendor-insufficient-funds' | 'item-drop-rejected' | 'item-transfer-rejected' | 'equipment-rejected',
    message: string
  ) {
    super(message);
    this.name = 'CommandRejected';
  }
}
