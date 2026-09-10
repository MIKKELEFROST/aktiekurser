/* Tailwind bruges kun til et lag hjælpeklasser oven på sitets eget designsystem
   i assets/kursliste.css. Play-CDN'en kunne bygge dem i browseren, men den
   koster 126 KB JavaScript og en oversættelse af hele stylesheetet ved hver
   eneste sidevisning — og Tailwinds egen dokumentation siger, at den ikke er
   til produktion.
     
   assets/tailwind.css er derfor bygget én gang og lagt i repoet. Sitet har
   stadig intet byggetrin: filen er en almindelig statisk fil som alle andre.
   Tilføjer du en ny hjælpeklasse i en HTML-fil, skal den bygges igen:

     node scripts/byg-css.mjs
*/
module.exports = {
  content: ['./*.html', './assets/*.js'],
  theme: { extend: { fontFamily: { sans: ['Porteron', 'Arial', 'system-ui', 'sans-serif'] } } },
};
