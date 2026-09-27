// Boilerplate the workspace starts with.

export const STARTER_FILES: Record<string, string> = {
  'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="card">
    <h1>Hello, Lockdown IDE!</h1>
    <p>Edit <code>index.html</code>, <code>style.css</code> and <code>script.js</code>. The preview updates as you type.</p>
    <button id="counter" type="button">Clicked 0 times</button>
  </main>

  <script src="script.js"></script>
</body>
</html>
`,
  'style.css': `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #f4f6fb;
  color: #1f2430;
}

.card {
  max-width: 28rem;
  padding: 2rem;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.08);
}

h1 {
  margin-top: 0;
  color: #0e639c;
}

button {
  padding: 0.6rem 1.2rem;
  border: 0;
  border-radius: 6px;
  background: #0e639c;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}

button:hover {
  background: #1177bb;
}
`,
  'script.js': `// Anything you console.log() shows up in the Console panel.
const button = document.getElementById('counter');
let clicks = 0;

button.addEventListener('click', () => {
  clicks += 1;
  button.textContent = \`Clicked \${clicks} time\${clicks === 1 ? '' : 's'}\`;
  console.log('Button clicked:', clicks);
});

console.log('script.js loaded at', new Date().toLocaleTimeString());
`,
};
