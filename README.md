# 🎵 Hinário Cifrado

Aplicativo PWA para músicos e corais — busca cifras de louvores gospel via IA, transpõe tom, metrônomo integrado.

## Como publicar no Vercel (gratuito)

### Opção 1 — Vercel CLI (mais rápido)
```bash
npm i -g vercel
cd hinario
vercel --prod
```

### Opção 2 — Interface Web
1. Acesse [vercel.com](https://vercel.com) e crie uma conta gratuita
2. Clique em **"Add New Project"**
3. Escolha **"Deploy without Git"** (arrastar pasta)
4. Arraste a pasta **`hinario/`** inteira para a área indicada
5. Clique **Deploy** — em segundos o app estará no ar!

### Opção 3 — Via GitHub
1. Crie um repositório no GitHub e faça upload dos arquivos
2. No Vercel, conecte o repositório
3. Deploy automático a cada push ✓

## Arquivos do projeto
```
hinario/
├── index.html      ← App completo (HTML + CSS + JS)
├── manifest.json   ← PWA manifest
├── vercel.json     ← Configuração Vercel
└── README.md       ← Este arquivo
```

## Funcionalidades
- 🔍 Busca cifras via IA (Claude) + busca web
- ✏️ Adicionar cifras manualmente
- 🎵 Metrônomo com padrão de batida por ritmo
- 🎸 Transposição de tom em tempo real
- 📖 Visualização 1/2/3 colunas ou tela cheia
- 🖨️ Impressão formatada
- 💾 Salva localmente no navegador (localStorage)
- 📱 Instalável como app (PWA)

## Notas
- A API da Anthropic é chamada diretamente do browser
- Os louvores ficam salvos no dispositivo do usuário
- Funciona offline após primeiro acesso (louvores já salvos)
