let clicks = 0;
const button = document.getElementById('count');
button.addEventListener('click', () => {
  clicks += 1;
  button.textContent = `Clicked ${clicks} times`;
});
