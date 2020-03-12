return (function (template, ctx) {
let out = "";
ctx.$lineNumber = 1;
ctx.$filename = "{{__dirname}}index.edge";
try {
out += template.renderWithState("components-props/alert", { "title": "H1" }, { main: function () {
let slot_main = "";
try {
slot_main += "Hello world";
} catch (error) {
ctx.reThrow(error);
}
return slot_main;
} });
} catch (error) {
ctx.reThrow(error);
}
return out;
})(template, ctx)