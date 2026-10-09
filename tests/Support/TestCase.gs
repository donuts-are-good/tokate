package TokateTests

internal class TestCase[T](name string, body async (T) -> void) {
    internal let Name string = name

    internal func Run(context T) {
        await body(context)
    }
}
