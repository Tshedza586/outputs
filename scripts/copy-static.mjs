import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
for (const file of ['index.html', 'style.css', 'reports.css']) await copyFile(file, `dist/public/${file}`);
await copyFile('dist/app.js', 'dist/public/app.js');
