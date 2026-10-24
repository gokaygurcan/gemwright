// Text made safe inside HTML text and attribute values.
export const escapeHtml = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
