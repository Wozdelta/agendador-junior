/** Provider names stay here; the editor always calls the caption description. */
export const youtubeFields = (t: { title: string; description: string }) => ({ title: t.title, description: t.description, categoryId: '22' });
export const facebookFields = (t: { title: string; description: string }) => ({ title: t.title || undefined, description: t.description });
export const instagramFields = (t: { description: string }) => ({ caption: t.description });
export const tiktokFields = (t: { description: string }) => ({ title: t.description });
