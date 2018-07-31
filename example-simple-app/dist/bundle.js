
      (function(modules) {
        function require(id) {
          const [fn, mapping] = modules[id];

          function localRequire(name) {
            return require(mapping[name]);
          }

          const module = { exports : {} };

          fn(localRequire, module, module.exports);

          return module.exports;
        }

        require(0);
      })({0: [
        function (require, module, exports) {
          "use strict";

var _message = require("./message");

var _message2 = _interopRequireDefault(_message);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

console.log(_message2.default);
        },
        {"./message":1},
      ],1: [
        function (require, module, exports) {
          "use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
const message = "Hello!";

exports.default = message;
        },
        {},
      ],})
    