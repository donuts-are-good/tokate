1.) Create a new Folder under goo-widgets/src/Goo.Widgets for Themes
2.) refactor Theme.gs to be included in the new Themes folder as the Goo Light/Goo Dark theme
3.) Create a new Goo Widget theme using the github dark colorscheme:

"base0"        : ["#0d1117", 233]
"base1"        : ["#161b22", 235]
"base2"        : ["#21262d", 237]
"base3"        : ["#89929b", 243]
"base4"        : ["#c6cdd5", 249]
"base5"        : ["#ecf2f8", 252]
"red"          : ["#fa7970", 210]
"orange"       : ["#faa356", 178]
"green"        : ["#7ce38b", 114]
"lightblue"    : ["#a2d2fb", 153]
"blue"         : ["#77bdfb", 75]
"purp"         : ["#cea5fb", 183]

4.) Verify the theme passes all applicable tests, gsfmt, gslint, all of the standard procedures for Goo.Widgets
