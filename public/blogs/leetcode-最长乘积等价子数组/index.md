## 题目描述

给你一个由 **正整数 **组成的数组 `nums`。

如果一个数组 `arr` 满足 `prod(arr) == lcm(arr) * gcd(arr)`，则称其为 **乘积等价数组 **，其中：

	- `prod(arr)` 表示 `arr` 中所有元素的乘积。

	- `gcd(arr)` 表示 `arr` 中所有元素的最大公因数 (GCD)。

	- `lcm(arr)` 表示 `arr` 中所有元素的最小公倍数 (LCM)。

返回数组 `nums` 的 **最长** **乘积等价 子数组 **的长度。

 

示例 1：

**输入：** nums = [1,2,1,2,1,1,1]

**输出：** 5

**解释：** 

最长的乘积等价子数组是 `[1, 2, 1, 1, 1]`，其中 `prod([1, 2, 1, 1, 1]) = 2`， `gcd([1, 2, 1, 1, 1]) = 1`，以及 `lcm([1, 2, 1, 1, 1]) = 2`。

示例 2：

**输入：** nums = [2,3,4,5,6]

**输出：** 3

**解释：** 

最长的乘积等价子数组是 `[3, 4, 5]`。

示例 3：

**输入：** nums = [1,2,3,1,4,5,1]

**输出：** 5

 

**提示：**

	- `2 <= nums.length <= 100`

	- `1 <= nums[i] <= 10`

## 解法

```java
class Solution {
    public int maxLength(int[] nums) {
        int mx = Arrays.stream(nums).max().getAsInt();
        int allLcm = 1;
        for (int x : nums) {
            allLcm = lcm(allLcm, x);
        }

        int ans = 0;
        for (int i = 0; i < nums.length; i++) {
            int m = 1;
            int l = 1;
            int g = 0;
            for (int j = i; j < nums.length && m <= allLcm * mx; j++) {
                int x = nums[j];
                m *= x;
                l = lcm(l, x);
                g = gcd(g, x);
                if (m == l * g) {
                    ans = Math.max(ans, j - i + 1);
                }
            }
        }
        return ans;
    }

    private int gcd(int a, int b) {
        while (a != 0) {
            int tmp = a;
            a = b % a;
            b = tmp;
        }
        return b;
    }

    private int lcm(int a, int b) {
        return a / gcd(a, b) * b;
    }

}
```
