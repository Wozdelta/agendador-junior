// Dados exibidos em /termos e /privacidade.
// Campos com null aparecem destacados como "PREENCHER" nas páginas e precisam
// ser completados ANTES de enviar as URLs para revisão do TikTok, Google ou Meta.
export const LEGAL = {
  appName: 'Agendador Junior',
  /** Nome da pessoa ou empresa responsável pelo app (controlador dos dados, LGPD). */
  operatorName: null as string | null,
  /** E-mail para contato, pedidos de exclusão e dúvidas sobre privacidade. */
  contactEmail: null as string | null,
  /** Onde o backend roda (ex.: "computador pessoal no Brasil" ou "VPS em São Paulo"). */
  backendLocation: null as string | null,
  /** Por quanto tempo vídeos, capas e histórico são mantidos depois da publicação. */
  retentionPolicy: null as string | null,
  /** Foro / legislação aplicável aos termos (ex.: "leis da República Federativa do Brasil, foro de …"). */
  governingLaw: null as string | null,
  lastUpdated: '14/11/2026',
};

export const MISSING_FIELDS: string[] = [
  LEGAL.operatorName ? '' : 'nome do responsável',
  LEGAL.contactEmail ? '' : 'e-mail de contato',
  LEGAL.backendLocation ? '' : 'local onde o backend e os arquivos ficam armazenados',
  LEGAL.retentionPolicy ? '' : 'política de retenção',
  LEGAL.governingLaw ? '' : 'legislação/foro aplicável',
].filter(Boolean);
